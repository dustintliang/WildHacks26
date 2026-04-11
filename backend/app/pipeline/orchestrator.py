"""
orchestrator.py — Pipeline orchestrator using VesselPipeline class.

Stages 2–5 flow through VesselPipeline. Stages 6–8 still call original
step modules. Step 1 preprocessing has been removed; VesselBoost handles
N4 bias correction and denoising internally via prep_mode=3.
"""

import logging
import time
from typing import Any, Callable

import numpy as np

from app.config import ARTERY_NAMES, OUTPUT_DIR
from app.models import (
    AnalysisResponse, ArteryResult, GeminiReport, RiskScore, SliceImages,
)
from app.pipeline.vessel_pipeline import ArteryMetrics, VesselPipeline
from app.pipeline.vesselboost_wrapper import VesselBoostWrapper, VesselMask
from app.utils.gpu_check import check_gpu

logger = logging.getLogger(__name__)


def run_pipeline(job_id: str, input_path: str,
                 progress_callback: Callable[[int, str], None] = None) -> dict:
    start = time.time()
    job_dir = OUTPUT_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    warnings: list[str] = []
    step_errors: dict[str, str] = {}

    if not check_gpu():
        warnings.append("No GPU detected. Running on CPU — slower.")

    def _p(step, msg):
        if progress_callback:
            progress_callback(step, msg)

    vessel_mask: VesselMask | None = None
    labeled_array: np.ndarray | None = None
    artery_dict: dict[str, np.ndarray | None] = {}
    centerlines: dict = {}
    metrics: dict[str, ArteryMetrics] = {}
    svd_result = None
    slice_images: dict[str, SliceImages] = {}
    gemini_report = GeminiReport()
    risk_scores: dict[str, RiskScore] = {}

    pipeline = VesselPipeline(wrapper=VesselBoostWrapper(prep_mode=3))

    # Step 1 — handled by VesselBoost prep_mode=3
    _p(1, "Preparing input volume...")
    logger.info("Step 1: preprocessing delegated to VesselBoost (N4 + denoise).")

    # Step 2 — Segmentation
    _p(2, "Running AI vessel segmentation...")
    try:
        vessel_mask = pipeline.get_binary_mask(input_path, job_dir, job_id)
        logger.info(f"Mask shape={vessel_mask.array.shape}, "
                    f"vessels={int(vessel_mask.array.sum()):,} voxels")
    except Exception as exc:
        logger.error(f"Step 2 failed: {exc}", exc_info=True)
        step_errors["segmentation"] = str(exc)

    # Step 3 — Labeling
    _p(3, "Annotating cerebrovascular structures...")
    if vessel_mask is not None:
        try:
            labeled_array, artery_dict = pipeline.label_arteries(
                vessel_mask, input_path, job_dir, job_id)
        except Exception as exc:
            logger.error(f"Step 3 failed: {exc}", exc_info=True)
            step_errors["labeling"] = str(exc)
    else:
        step_errors["labeling"] = "Skipped: no vessel mask."

    # Step 4 — Centerlines
    _p(4, "Extracting anatomical centerlines...")
    if vessel_mask is not None and artery_dict:
        try:
            centerlines = pipeline.extract_centerlines(vessel_mask, artery_dict)
        except Exception as exc:
            logger.error(f"Step 4 failed: {exc}", exc_info=True)
            step_errors["centerline"] = str(exc)
    else:
        step_errors["centerline"] = "Skipped: missing inputs."

    # Step 5 — Metrics + SVD
    _p(5, "Calculating pathology features...")
    if vessel_mask is not None and centerlines and artery_dict:
        try:
            metrics = pipeline.compute_metrics(vessel_mask, centerlines, artery_dict)
        except Exception as exc:
            logger.error(f"Step 5 failed: {exc}", exc_info=True)
            step_errors["metrics"] = str(exc)
        try:
            from app.pipeline.step5_features import compute_svd_proxy
            svd_result, w = compute_svd_proxy(
                vessel_mask.source_path, input_path,
                {n: {"centerline_points": c.points_voxel,
                     "radii": c.radii_mm,
                     "segment_length_mm": c.segment_length_mm}
                 for n, c in centerlines.items()})
            warnings.extend(w)
        except Exception as exc:
            logger.error(f"Step 5d (SVD) failed: {exc}", exc_info=True)
            step_errors["svd"] = str(exc)

    stenosis_results = {n: m.stenosis for n, m in metrics.items()} if metrics \
                       else {n: [] for n in ARTERY_NAMES}
    aneurysm_results = {n: m.aneurysms for n, m in metrics.items()} if metrics \
                       else {n: [] for n in ARTERY_NAMES}
    tortuosity_results = {n: m.tortuosity for n, m in metrics.items() if m.tortuosity}

    # Build and save overlay NIfTI (between step 5 and step 6)
    overlay_path = ""
    mask_shape: list[int] = []
    mask_voxel_size: list[float] = []
    mask_affine: list[list[float]] = []
    vessel_voxel_count: int = 0

    if vessel_mask is not None:
        mask_shape = list(vessel_mask.array.shape)
        mask_voxel_size = list(vessel_mask.voxel_size)
        mask_affine = vessel_mask.affine.tolist()
        vessel_voxel_count = int(vessel_mask.array.sum())
        if metrics:
            try:
                import nibabel as nib
                overlay_array = VesselPipeline.build_overlay(vessel_mask.array.shape, metrics)
                overlay_img = nib.Nifti1Image(overlay_array, vessel_mask.affine)
                overlay_nii_path = job_dir / f"{job_id}_overlay.nii.gz"
                nib.save(overlay_img, str(overlay_nii_path))
                overlay_path = str(overlay_nii_path)
                logger.info(f"Overlay NIfTI saved: {overlay_nii_path}")
            except Exception as exc:
                logger.error(f"Overlay save failed: {exc}", exc_info=True)
                step_errors["overlay"] = str(exc)

    # Step 6 — Render
    _p(6, "Generating 2D slices...")
    features = {"stenosis": stenosis_results, "aneurysms": aneurysm_results,
                "tortuosity": tortuosity_results}
    if vessel_mask is not None and labeled_array is not None and artery_dict:
        try:
            from app.pipeline.step6_render import render_slices
            labeled_path = job_dir / f"{job_id}_labeled.nii.gz"
            slice_images = render_slices(
                input_path, str(vessel_mask.source_path), str(labeled_path),
                artery_dict, features, job_dir, job_id)
        except Exception as exc:
            logger.error(f"Step 6 failed: {exc}", exc_info=True)
            step_errors["rendering"] = str(exc)
    else:
        step_errors["rendering"] = "Skipped: missing inputs."

    # Step 7 — Gemini
    _p(7, "Awaiting AI interpretation report...")
    try:
        from app.pipeline.step7_gemini import generate_gemini_report
        features_json = _build_features_json(
            stenosis_results, aneurysm_results, tortuosity_results, svd_result)
        gemini_report, w = generate_gemini_report(slice_images, features_json)
        warnings.extend(w)
    except Exception as exc:
        logger.error(f"Step 7 failed: {exc}", exc_info=True)
        step_errors["gemini_report"] = str(exc)

    # Step 8 — Risk
    _p(8, "Computing final risk scores...")
    try:
        from app.pipeline.step8_risk import compute_risk_scores
        risk_scores = compute_risk_scores(
            stenosis_results, aneurysm_results, tortuosity_results, svd_result)
    except Exception as exc:
        logger.error(f"Step 8 failed: {exc}", exc_info=True)
        step_errors["risk_scores"] = str(exc)

    elapsed = time.time() - start
    logger.info(f"Pipeline complete for job {job_id} in {elapsed:.1f}s")

    arteries: dict[str, ArteryResult] = {}
    for name in ARTERY_NAMES:
        m = metrics.get(name)
        vox = m.artery_voxels if (m and m.visible and m.artery_voxels is not None
                                   and len(m.artery_voxels) > 0) else None
        cl = m.centerline_voxels if (m and m.visible and m.centerline_voxels is not None
                                      and len(m.centerline_voxels) > 0) else None
        radii = m.radii_mm if (m and m.radii_mm is not None and len(m.radii_mm) > 0) else None
        arteries[name] = ArteryResult(
            visible=bool(m and m.visible),
            stenosis_candidates=[c.model_dump() if hasattr(c, "model_dump") else c
                                  for c in (m.stenosis if m else [])],
            aneurysm_candidates=[c.model_dump() if hasattr(c, "model_dump") else c
                                  for c in (m.aneurysms if m else [])],
            tortuosity=m.tortuosity if m else None,
            small_vessel_disease=svd_result,
            voxel_count=int(len(vox)) if vox is not None else 0,
            voxel_indices=vox.tolist() if vox is not None else [],
            centerline_indices=cl.tolist() if cl is not None else [],
            mean_radius_mm=float(np.mean(radii)) if radii is not None else 0.0,
            segment_length_mm=float(m.segment_length_mm) if m else 0.0,
            analysis=_build_artery_analysis(name, m) if m else f"{name} is not visible in this scan.",
        )

    response = AnalysisResponse(
        job_id=job_id, status="complete",
        output_mask_path=str(vessel_mask.source_path) if vessel_mask else "",
        overlay_path=overlay_path,
        mask_shape=mask_shape,
        mask_voxel_size=mask_voxel_size,
        mask_affine=mask_affine,
        vessel_voxel_count=vessel_voxel_count,
        arteries=arteries,
        risk_scores={k: v if isinstance(v, RiskScore) else RiskScore(**v)
                     for k, v in risk_scores.items()},
        gemini_report=gemini_report,
        slice_images=slice_images,
        warnings=warnings,
        step_errors=step_errors,
    )
    return response.model_dump()


def _build_artery_analysis(name: str, m: "ArteryMetrics") -> str:
    """One-or-two sentence summary of findings for a single artery."""
    if not m.visible:
        return f"{name} is not visible in this scan."
    parts = []
    severe = [s for s in m.stenosis if getattr(s, "severity", "") == "severe"]
    moderate = [s for s in m.stenosis if getattr(s, "severity", "") == "moderate"]
    if severe:
        parts.append(f"{len(severe)} severe stenosis site(s)")
    elif moderate:
        parts.append(f"{len(moderate)} moderate stenosis site(s)")
    high_aneu = [a for a in m.aneurysms if getattr(a, "confidence", "") == "high"]
    if high_aneu:
        parts.append(f"{len(high_aneu)} high-confidence aneurysm candidate(s)")
    elif m.aneurysms:
        parts.append(f"{len(m.aneurysms)} aneurysm candidate(s)")
    if m.tortuosity and getattr(m.tortuosity, "flagged", False):
        parts.append("elevated tortuosity")
    if not parts:
        return f"{name} appears normal with no significant findings."
    return f"{name}: {'; '.join(parts)}."


def _build_features_json(stenosis, aneurysms, tortuosity, svd) -> dict:
    out: dict[str, Any] = {"stenosis": {}, "aneurysms": {}, "tortuosity": {}, "svd": None}
    for name in ARTERY_NAMES:
        out["stenosis"][name] = [c.model_dump() if hasattr(c, "model_dump") else c
                                  for c in stenosis.get(name, [])]
        out["aneurysms"][name] = [c.model_dump() if hasattr(c, "model_dump") else c
                                   for c in aneurysms.get(name, [])]
        t = tortuosity.get(name)
        if t:
            out["tortuosity"][name] = t.model_dump() if hasattr(t, "model_dump") else t
    if svd:
        out["svd"] = svd.model_dump() if hasattr(svd, "model_dump") else svd
    return out