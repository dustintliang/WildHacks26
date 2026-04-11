"""
vesselboost_wrapper.py — Thin wrapper around the VesselBoost CLI.

Responsibility: take a NIfTI path in, return a binary vessel mask as a
numpy array (plus its affine + voxel size). Nothing else. All downstream
geometric analysis lives in VesselPipeline.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import nibabel as nib
import numpy as np

from app.config import VESSELBOOST_DIR, VESSELBOOST_MODEL_DIR
from app.utils.nifti_utils import get_data, get_voxel_size, load_nifti, save_nifti

logger = logging.getLogger(__name__)


@dataclass
class VesselMask:
    """Binary vessel mask + spatial metadata. Returned by VesselBoostWrapper."""
    array: np.ndarray              # uint8, shape (X, Y, Z), values 0/1
    affine: np.ndarray             # (4, 4)
    voxel_size: tuple[float, ...]  # mm per voxel
    source_path: Path              # path the mask was saved to


class VesselBoostWrapper:
    """
    Calls VesselBoost's prediction.py (local install or Docker), then
    returns the result as a numpy array via `segment()`.

    Usage:
        wrapper = VesselBoostWrapper(model_dir=VESSELBOOST_MODEL_DIR)
        mask = wrapper.segment("scan.nii.gz", out_dir="/tmp/job1", job_id="job1")
        # mask.array is a uint8 ndarray
    """

    def __init__(
        self,
        repo_dir: Path = VESSELBOOST_DIR,
        model_dir: Path = VESSELBOOST_MODEL_DIR,
        prep_mode: int = 4,
        timeout_s: int = 1800,
        python: str = sys.executable,
    ):
        self.repo_dir = Path(repo_dir)
        self.model_dir = Path(model_dir)
        self.prep_mode = prep_mode
        self.timeout_s = timeout_s
        self.python = python
        self.script = self.repo_dir / "prediction.py"

    # ---------- public API ----------

    def is_available(self) -> bool:
        return self.script.exists() and self.model_dir.exists()

    def segment(
        self,
        input_path: str | Path,
        out_dir: str | Path,
        job_id: str,
    ) -> VesselMask:
        """Run VesselBoost and return the binary mask as a numpy array."""
        out_dir = Path(out_dir); out_dir.mkdir(parents=True, exist_ok=True)
        mask_path = out_dir / f"{job_id}_vessel_mask.nii.gz"

        if self.is_available() and self._run_local(input_path, out_dir, job_id, mask_path):
            logger.info(f"VesselBoost (local) succeeded → {mask_path}")
        elif self._run_docker(input_path, out_dir, mask_path):
            logger.info(f"VesselBoost (docker) succeeded → {mask_path}")
        else:
            logger.warning("VesselBoost unavailable; using Otsu fallback.")
            self._fallback_otsu(input_path, mask_path)

        return self._load_as_vessel_mask(mask_path)

    # ---------- internals ----------

    def _run_local(self, input_path, out_dir, job_id, mask_path) -> bool:
        pred_dir = Path(out_dir) / f"{job_id}_vb_pred"
        pred_dir.mkdir(parents=True, exist_ok=True)
        cmd = [
            self.python, str(self.script),
            "--image_path", str(input_path),
            "--output_path", str(pred_dir),
            "--pretrained", str(self.model_dir),
            "--prep_mode", str(self.prep_mode),
        ]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True,
                               timeout=self.timeout_s, cwd=self.repo_dir)
            if r.returncode != 0:
                logger.warning(f"VesselBoost failed: {r.stderr[:400]}")
                return False
            outs = sorted(pred_dir.glob("*.nii*"), key=lambda p: p.stat().st_mtime)
            if not outs:
                return False
            self._binarize_and_save(outs[-1], mask_path)
            return True
        except Exception as e:
            logger.warning(f"VesselBoost local error: {e}")
            return False

    def _run_docker(self, input_path, out_dir, mask_path) -> bool:
        if shutil.which("docker") is None:
            return False
        try:
            ip, od = Path(input_path).resolve(), Path(out_dir).resolve()
            cmd = [
                "docker", "run", "--rm",
                "-v", f"{ip.parent}:/input", "-v", f"{od}:/output",
                "vnmd/vesselboost_2.0.1", "prediction.py",
                "--image_path", f"/input/{ip.name}",
                "--output_path", "/output", "--prep_mode", str(self.prep_mode),
            ]
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=self.timeout_s)
            if r.returncode != 0:
                return False
            outs = list(od.glob("*prediction*")) or list(od.glob("*.nii*"))
            if not outs:
                return False
            self._binarize_and_save(outs[0], mask_path)
            return True
        except Exception as e:
            logger.warning(f"VesselBoost docker error: {e}")
            return False

    def _binarize_and_save(self, src: Path, dst: Path) -> None:
        img = load_nifti(src)
        binary = (get_data(img) > 0.5).astype(np.uint8)
        save_nifti(binary, img.affine, dst, header=img.header)

    def _fallback_otsu(self, input_path, mask_path) -> None:
        from scipy import ndimage
        from skimage.filters import threshold_otsu
        from skimage.morphology import remove_small_objects
        img = load_nifti(input_path); data = get_data(img)
        nz = data[data > 0]
        thr = threshold_otsu(nz) if len(nz) else 0
        m = data > thr
        m = ndimage.binary_closing(m, iterations=1)
        m = ndimage.binary_opening(m, iterations=1)
        m = remove_small_objects(m, min_size=50)
        save_nifti(m.astype(np.uint8), img.affine, mask_path, header=img.header)

    def _load_as_vessel_mask(self, mask_path: Path) -> VesselMask:
        img = load_nifti(mask_path)
        return VesselMask(
            array=get_data(img).astype(np.uint8),
            affine=img.affine,
            voxel_size=get_voxel_size(img),
            source_path=Path(mask_path),
        )