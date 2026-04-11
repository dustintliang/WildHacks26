"""
orchestrator.py — Pipeline orchestrator that runs Steps 1–8 sequentially.

Each step is wrapped in try/except so a failure in one step does not
crash the whole job. Failed steps are logged and marked in the response.
"""

import logging
import time
from pathlib import Path
from typing import Any

import numpy as np

from app.config import ARTERY_NAMES, OUTPUT_DIR
from app.models import (
    AnalysisResponse,
    ArteryResult,
    GeminiReport,
    RiskScore,
    SliceImages,
)
from app.utils.gpu_check import check_gpu

logger = logging.getLogger(__name__)


def run_pipeline(job_id: str, input_path: str) -> dict:
    """
    Execute the full 8-step cerebrovascular analysis pipeline.

    Args:
        job_id: Unique job identifier.
        input_path: Path to the uploaded raw NIfTI file.

    Returns:
        Serializable dict matching the AnalysisResponse schema.
    """
    start_time = time.time()

    # Job output directory
    job_dir = OUTPUT_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    warnings: list[str] = []
    step_errors: dict[str, str] = {}

    # Check GPU
    gpu_available = check_gpu()
    if not gpu_available:
        warnings.append(
            "No GPU detected. Pipeline running on CPU — this will be slower."
        )

    # Initialize result containers
    preprocessed_path = input_path
    vessel_mask_path = ""
    labeled_path = ""
    artery_dict: dict[str, Any] = {}
    centerline_data: dict[str, dict] = {}
    stenosis_results: dict = {}
    aneurysm_results: dict = {}
    tortuosity_results: dict = {}
    svd_result = None
    slice_images: dict[str, SliceImages] = {}
    gemini_report = GeminiReport()
    risk_scores: dict[str, RiskScore] = {}
    voxel_size = (0.5, 0.5, 0.5)
    affine = np.eye(4)

    # ===================================================================
    # Step 1 — Preprocessing
    # ===================================================================
    logger.info(f"{'='*60}")
    logger.info(f"STEP 1: Preprocessing — Job {job_id}")
    logger.info(f"{'='*60}")
    try:
        from app.pipeline.step1_preprocess import preprocess
        preprocessed_path, step_warnings = preprocess(
            input_path, job_dir, job_id
        )
        warnings.extend(step_warnings)

        # Read voxel size and affine from preprocessed image
        from app.utils.nifti_utils import get_voxel_size, load_nifti
        prep_img = load_nifti(preprocessed_path)
        voxel_size = get_voxel_size(prep_img)
        affine = prep_img.affine
        logger.info(f"Step 1 complete. Voxel size: {voxel_size}")
    except Exception as exc:
        msg = f"Step 1 (Preprocessing) failed: {exc}"
        logger.error(msg, exc_info=True)
        step_errors["preprocessing"] = str(exc)

    # ===================================================================
    # Step 2 — Vessel Segmentation
    # ===================================================================
    logger.info(f"{'='*60}")
    logger.info(f"STEP 2: Vessel Segmentation — Job {job_id}")
    logger.info(f"{'='*60}")
    try:
        from app.pipeline.step2_segment import segment_vessels
        vessel_mask_path, step_warnings = segment_vessels(
            preprocessed_path, job_dir, job_id
        )
        warnings.extend(step_warnings)
        logger.info(f"Step 2 complete. Mask: {vessel_mask_path}")
    except Exception as exc:
        msg = f"Step 2 (Segmentation) failed: {exc}"
        logger.error(msg, exc_info=True)
        step_errors["segmentation"] = str(exc)

    # ===================================================================
    # Step 3 — Artery Labeling
    # ===================================================================
    logger.info(f"{'='*60}")
    logger.info(f"STEP 3: Artery Labeling — Job {job_id}")
    logger.info(f"{'='*60}")
    if vessel_mask_path:
        try:
            from app.pipeline.step3_label import label_arteries
            labeled_path, artery_dict, step_warnings = label_arteries(
                vessel_mask_path, preprocessed_path, job_dir, job_id
            )
            warnings.extend(step_warnings)
            logger.info(f"Step 3 complete. Labeled: {labeled_path}")
        except Exception as exc:
            msg = f"Step 3 (Labeling) failed: {exc}"
            logger.error(msg, exc_info=True)
            step_errors["labeling"] = str(exc)
    else:
        step_errors["labeling"] = "Skipped: no vessel mask from Step 2."

    # ===================================================================
    # Step 4 — Centerline and Radius Extraction
    # ===================================================================
    logger.info(f"{'='*60}")
    logger.info(f"STEP 4: Centerline Extraction — Job {job_id}")
    logger.info(f"{'='*60}")
    if vessel_mask_path and labeled_path and artery_dict:
        try:
            from app.pipeline.step4_centerline import extract_centerlines
            centerline_data, step_warnings = extract_centerlines(
                vessel_mask_path, labeled_path, artery_dict, voxel_size
            )
            warnings.extend(step_warnings)
            logger.info("Step 4 complete.")
        except Exception as exc:
            msg = f"Step 4 (Centerline) failed: {exc}"
            logger.error(msg, exc_info=True)
            step_errors["centerline"] = str(exc)
    else:
        step_errors["centerline"] = "Skipped: missing inputs from Steps 2/3."

    # ===================================================================
    # Step 5 — Feature Extraction
    # ===================================================================
    logger.info(f"{'='*60}")
    logger.info(f"STEP 5: Feature Extraction — Job {job_id}")
    logger.info(f"{'='*60}")

    # 5a. Stenosis
    try:
        from app.pipeline.step5_features import compute_stenosis
        stenosis_results = compute_stenosis(
            centerline_data, voxel_size, affine
        )
        logger.info("Step 5a (Stenosis) complete.")
    except Exception as exc:
        logger.error(f"Step 5a (Stenosis) failed: {exc}", exc_info=True)
        step_errors["stenosis"] = str(exc)
        stenosis_results = {name: [] for name in ARTERY_NAMES}

    # 5b. Aneurysm
    try:
        from app.pipeline.step5_features import detect_aneurysms
        if vessel_mask_path and artery_dict:
            aneurysm_results = detect_aneurysms(
                centerline_data, vessel_mask_path,
                artery_dict, voxel_size, affine
            )
        else:
            aneurysm_results = {name: [] for name in ARTERY_NAMES}
        logger.info("Step 5b (Aneurysm) complete.")
    except Exception as exc:
        logger.error(f"Step 5b (Aneurysm) failed: {exc}", exc_info=True)
        step_errors["aneurysm"] = str(exc)
        aneurysm_results = {name: [] for name in ARTERY_NAMES}

    # 5c. Tortuosity
    try:
        from app.pipeline.step5_features import compute_tortuosity
        tortuosity_results = compute_tortuosity(centerline_data, voxel_size)
        logger.info("Step 5c (Tortuosity) complete.")
    except Exception as exc:
        logger.error(f"Step 5c (Tortuosity) failed: {exc}", exc_info=True)
        step_errors["tortuosity"] = str(exc)
        tortuosity_results = {}

    # 5d. Small Vessel Disease
    try:
        from app.pipeline.step5_features import compute_svd_proxy
        if vessel_mask_path:
            svd_result, step_warnings = compute_svd_proxy(
                vessel_mask_path, preprocessed_path, centerline_data
            )
            warnings.extend(step_warnings)
        logger.info("Step 5d (SVD) complete.")
    except Exception as exc:
        logger.error(f"Step 5d (SVD) failed: {exc}", exc_info=True)
        step_errors["svd"] = str(exc)

    # ===================================================================
    # Step 6 — 2D Slice Rendering
    # ===================================================================
    logger.info(f"{'='*60}")
    logger.info(f"STEP 6: Slice Rendering — Job {job_id}")
    logger.info(f"{'='*60}")
    features = {
        "stenosis": stenosis_results,
        "aneurysms": aneurysm_results,
        "tortuosity": tortuosity_results,
    }
    if vessel_mask_path and labeled_path and artery_dict:
        try:
            from app.pipeline.step6_render import render_slices
            slice_images = render_slices(
                preprocessed_path, vessel_mask_path, labeled_path,
                artery_dict, features, job_dir, job_id
            )
            logger.info(f"Step 6 complete. Rendered {len(slice_images)} arteries.")
        except Exception as exc:
            logger.error(f"Step 6 (Rendering) failed: {exc}", exc_info=True)
            step_errors["rendering"] = str(exc)
    else:
        step_errors["rendering"] = "Skipped: missing inputs."

    # ===================================================================
    # Step 7 — Gemini Report Generation
    # ===================================================================
    logger.info(f"{'='*60}")
    logger.info(f"STEP 7: Gemini Report — Job {job_id}")
    logger.info(f"{'='*60}")
    try:
        from app.pipeline.step7_gemini import generate_gemini_report

        # Build serializable features dict for Gemini
        features_json = _build_features_json(
            stenosis_results, aneurysm_results,
            tortuosity_results, svd_result
        )

        gemini_report, step_warnings = generate_gemini_report(
            slice_images, features_json
        )
        warnings.extend(step_warnings)
        logger.info("Step 7 complete.")
    except Exception as exc:
        logger.error(f"Step 7 (Gemini) failed: {exc}", exc_info=True)
        step_errors["gemini_report"] = str(exc)

    # ===================================================================
    # Step 8 — Risk Score Computation
    # ===================================================================
    logger.info(f"{'='*60}")
    logger.info(f"STEP 8: Risk Scoring — Job {job_id}")
    logger.info(f"{'='*60}")
    try:
        from app.pipeline.step8_risk import compute_risk_scores
        risk_scores = compute_risk_scores(
            stenosis_results, aneurysm_results,
            tortuosity_results, svd_result
        )
        logger.info("Step 8 complete.")
    except Exception as exc:
        logger.error(f"Step 8 (Risk) failed: {exc}", exc_info=True)
        step_errors["risk_scores"] = str(exc)

    # ===================================================================
    # Assemble final response
    # ===================================================================
    elapsed = time.time() - start_time
    logger.info(f"Pipeline complete for job {job_id} in {elapsed:.1f}s")

    # Build per-artery results
    arteries: dict[str, ArteryResult] = {}
    for name in ARTERY_NAMES:
        voxels = artery_dict.get(name)
        visible = voxels is not None and (
            isinstance(voxels, np.ndarray) and voxels.shape[0] > 0
        )

        arteries[name] = ArteryResult(
            visible=visible,
            stenosis_candidates=[
                c.model_dump() if hasattr(c, "model_dump") else c
                for c in stenosis_results.get(name, [])
            ],
            aneurysm_candidates=[
                c.model_dump() if hasattr(c, "model_dump") else c
                for c in aneurysm_results.get(name, [])
            ],
            tortuosity=tortuosity_results.get(name),
            small_vessel_disease=svd_result,
        )

    # Build response
    response = AnalysisResponse(
        job_id=job_id,
        status="complete",
        output_mask_path=vessel_mask_path,
        arteries=arteries,
        risk_scores={
            k: v if isinstance(v, RiskScore) else RiskScore(**v)
            for k, v in risk_scores.items()
        },
        gemini_report=gemini_report,
        slice_images=slice_images,
        warnings=warnings,
        step_errors=step_errors,
    )

    return response.model_dump()


def _build_features_json(
    stenosis_results: dict,
    aneurysm_results: dict,
    tortuosity_results: dict,
    svd_result: Any,
) -> dict:
    """Build a JSON-serializable features dict for Gemini."""
    features: dict[str, Any] = {
        "stenosis": {},
        "aneurysms": {},
        "tortuosity": {},
        "svd": None,
    }

    for name in ARTERY_NAMES:
        # Stenosis
        candidates = stenosis_results.get(name, [])
        features["stenosis"][name] = [
            c.model_dump() if hasattr(c, "model_dump") else c
            for c in candidates
        ]

        # Aneurysms
        candidates = aneurysm_results.get(name, [])
        features["aneurysms"][name] = [
            c.model_dump() if hasattr(c, "model_dump") else c
            for c in candidates
        ]

        # Tortuosity
        t = tortuosity_results.get(name)
        if t:
            features["tortuosity"][name] = (
                t.model_dump() if hasattr(t, "model_dump") else t
            )

    # SVD
    if svd_result:
        features["svd"] = (
            svd_result.model_dump() if hasattr(svd_result, "model_dump")
            else svd_result
        )

    return features
