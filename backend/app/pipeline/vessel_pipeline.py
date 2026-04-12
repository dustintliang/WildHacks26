"""
vessel_pipeline.py — Stage-by-stage pipeline class.

Each method maps to one Stage from the design discussion and returns
numpy arrays alongside any metrics so callers can re-render, debug, or
chain stages independently.

Stages
------
    get_binary_mask(...)        → VesselMask                  (Stage 1a, via wrapper)
    skeletonize(mask)           → np.ndarray (uint8)          (Stage 1b)
    distance_transform(mask)    → np.ndarray (float, mm)      (Stage 1c)
    label_arteries(...)         → (labeled_array, artery_dict) (Stage 1e)
    extract_centerlines(...)    → dict[name → CenterlineData] (Stage 1d/2 prep)
    compute_metrics(...)        → dict[name → ArteryMetrics]  (Stage 2)
    build_overlay(...)          → np.ndarray (uint8 labelmap) (Stage 3)
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from scipy import ndimage
from skimage.morphology import skeletonize as sk_skeletonize

from app.config import ARTERY_NAMES
from app.pipeline.vesselboost_wrapper import VesselBoostWrapper, VesselMask

logger = logging.getLogger(__name__)


@dataclass
class CenterlineData:
    points_voxel: np.ndarray              # (N, 3)
    radii_mm: np.ndarray                  # (N,)
    arc_length_mm: np.ndarray             # (N,) cumulative
    segment_length_mm: float
    artery_voxels: np.ndarray             # (M, 3) — all voxels of this artery


@dataclass
class ArteryMetrics:
    """Metrics for one named artery, with the underlying voxel data attached."""
    artery_name: str
    visible: bool
    artery_voxels: np.ndarray             # (M, 3) all mask voxels for this artery
    centerline_voxels: np.ndarray         # (N, 3)
    radii_mm: np.ndarray                  # (N,)
    segment_length_mm: float
    stenosis: list[Any] = field(default_factory=list)
    aneurysms: list[Any] = field(default_factory=list)
    tortuosity: Any = None


class VesselPipeline:
    """
    Stage-by-stage cerebrovascular analysis pipeline. Each method is
    independently callable; callers can run only the stages they need.
    """

    def __init__(self, wrapper: VesselBoostWrapper | None = None):
        self.wrapper = wrapper or VesselBoostWrapper()

    # ---------- Stage 1a ----------
    def get_binary_mask(
        self, input_nifti: str | Path, out_dir: str | Path, job_id: str
    ) -> VesselMask:
        """Run VesselBoost. Returns mask as numpy array (via VesselMask)."""
        return self.wrapper.segment(input_nifti, out_dir, job_id)

    # ---------- Stage 1b ----------
    @staticmethod
    def skeletonize(mask: np.ndarray) -> np.ndarray:
        """Reduce binary mask to a 1-voxel-thick centerline (same shape)."""
        return sk_skeletonize((mask > 0).astype(np.uint8)).astype(np.uint8)

    # ---------- Stage 1c ----------
    @staticmethod
    def distance_transform(
        mask: np.ndarray, voxel_size: tuple[float, ...]
    ) -> np.ndarray:
        """Per-voxel distance to background, in mm. Read at skeleton points → radii."""
        return ndimage.distance_transform_edt(mask > 0, sampling=voxel_size)

    # ---------- Stage 1e ----------
    def label_arteries(
        self,
        vessel_mask: VesselMask,
        original_path: str | Path,
        out_dir: str | Path,
        job_id: str,
    ) -> tuple[np.ndarray, dict[str, np.ndarray | None]]:
        """Delegate to step3_label, return (labeled_array, {name: voxels})."""
        from app.pipeline.step3_label import label_arteries as _label
        labeled_path, artery_dict, _ = _label(
            vessel_mask.source_path, original_path, out_dir, job_id
        )
        from app.utils.nifti_utils import get_data, load_nifti
        labeled_array = get_data(load_nifti(labeled_path)).astype(np.int16)
        return labeled_array, artery_dict

    # ---------- Stage 1d ----------
    def extract_centerlines(
        self,
        vessel_mask: VesselMask,
        artery_dict: dict[str, np.ndarray | None],
    ) -> dict[str, CenterlineData]:
        """
        For each named artery, isolate its sub-mask, skeletonize, read radii
        from the full-mask distance transform, and order centerline points.
        """
        full_dt = self.distance_transform(vessel_mask.array, vessel_mask.voxel_size)
        vsize = np.array(vessel_mask.voxel_size)
        out: dict[str, CenterlineData] = {}

        for name in ARTERY_NAMES:
            voxels = artery_dict.get(name)
            if voxels is None or len(voxels) == 0:
                out[name] = CenterlineData(
                    np.empty((0, 3), int), np.array([]), np.array([]),
                    0.0, np.empty((0, 3), int)
                )
                continue

            sub = np.zeros(vessel_mask.array.shape, dtype=bool)
            sub[voxels[:, 0], voxels[:, 1], voxels[:, 2]] = True

            from app.pipeline.step4_centerline import (
                _order_skeleton_points, _skeletonize_centerline,
            )
            pts, radii = _skeletonize_centerline(sub, vessel_mask.array, vessel_mask.voxel_size)

            if len(pts) >= 2:
                diffs = np.diff(pts * vsize, axis=0)
                steps = np.linalg.norm(diffs, axis=1)
                arc = np.concatenate([[0.0], np.cumsum(steps)])
                seg_len = float(arc[-1])
            else:
                arc = np.zeros(len(pts))
                seg_len = 0.0

            out[name] = CenterlineData(
                points_voxel=pts, radii_mm=radii,
                arc_length_mm=arc, segment_length_mm=seg_len,
                artery_voxels=voxels,
            )
        return out

    # ---------- Stage 2 ----------
    def compute_metrics(
        self,
        vessel_mask: VesselMask,
        centerlines: dict[str, CenterlineData],
        artery_dict: dict[str, np.ndarray | None],
    ) -> dict[str, ArteryMetrics]:
        """Run stenosis / aneurysm / tortuosity over the centerlines."""
        from app.pipeline.step5_features import (
            compute_stenosis, compute_tortuosity, detect_aneurysms,
        )
        cd_dict = {  # adapt to step5's expected schema
            n: {
                "centerline_points": c.points_voxel,
                "radii": c.radii_mm,
                "segment_length_mm": c.segment_length_mm,
            } for n, c in centerlines.items()
        }
        sten = compute_stenosis(cd_dict, vessel_mask.voxel_size, vessel_mask.affine)
        aneu = detect_aneurysms(cd_dict, vessel_mask.source_path,
                                artery_dict, vessel_mask.voxel_size, vessel_mask.affine)
        tort = compute_tortuosity(cd_dict, vessel_mask.voxel_size)

        results: dict[str, ArteryMetrics] = {}
        for name in ARTERY_NAMES:
            c = centerlines[name]
            results[name] = ArteryMetrics(
                artery_name=name,
                visible=len(c.artery_voxels) > 0,
                artery_voxels=c.artery_voxels,
                centerline_voxels=c.points_voxel,
                radii_mm=c.radii_mm,
                segment_length_mm=c.segment_length_mm,
                stenosis=sten.get(name, []),
                aneurysms=aneu.get(name, []),
                tortuosity=tort.get(name),
            )
        return results

    # ---------- Stage 3 ----------
    @staticmethod
    def build_overlay(
        shape: tuple[int, int, int],
        metrics: dict[str, ArteryMetrics],
    ) -> np.ndarray:
        """
        Build a uint8 labelmap (same shape as the scan) where flagged
        centerline voxels are colored by severity:
            1 = normal vessel, 2 = mild stenosis, 3 = severe stenosis,
            4 = aneurysm candidate.
        """
        overlay = np.zeros(shape, dtype=np.uint8)
        for m in metrics.values():
            if m.centerline_voxels.size:
                cv = m.centerline_voxels.astype(int)
                overlay[cv[:, 0], cv[:, 1], cv[:, 2]] = 1
            for s in m.stenosis:
                code = 3 if getattr(s, "severity", "") == "severe" else 2
                v = np.array(getattr(s, "voxel_coordinates", []), int)
                if v.size == 3:
                    overlay[v[0], v[1], v[2]] = code
            for a in m.aneurysms:
                v = np.array(getattr(a, "bifurcation_voxel_coords", []), int)
                if v.size == 3:
                    overlay[v[0], v[1], v[2]] = 4
        return overlay