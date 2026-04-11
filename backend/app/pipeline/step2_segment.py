"""
step2_segment.py — Vessel segmentation using VesselBoost.

Pipeline Step 2:
    Run VesselBoost on the preprocessed NIfTI with test-time adaptation.
    Output: binary 3D vessel mask as a NIfTI file.
    Fallback: Otsu threshold + morphological cleanup if VesselBoost unavailable.
"""

import logging
import os
import shutil
import subprocess
import sys
from pathlib import Path

import nibabel as nib
import numpy as np

from app.config import VESSELBOOST_DIR, VESSELBOOST_MODEL_DIR
from app.utils.nifti_utils import get_data, load_nifti, save_nifti

logger = logging.getLogger(__name__)


def segment_vessels(
    preprocessed_path: str | Path,
    output_dir: str | Path,
    job_id: str,
) -> tuple[str, list[str]]:
    """
    Segment blood vessels from the preprocessed TOF-MRA.

    Attempts VesselBoost with test-time adaptation first, falls back
    to basic threshold-based segmentation if unavailable.

    Args:
        preprocessed_path: Path to the preprocessed NIfTI.
        output_dir: Directory for output files.
        job_id: Unique job identifier.

    Returns:
        Tuple of (path to binary vessel mask NIfTI, list of warnings).
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    warnings: list[str] = []

    mask_path = output_dir / f"{job_id}_vessel_mask.nii.gz"

    # --- Try VesselBoost ---
    success = _try_vesselboost(preprocessed_path, output_dir, job_id, mask_path)
    if success:
        logger.info("VesselBoost segmentation completed successfully.")
        return str(mask_path), warnings

    # --- Try VesselBoost Docker container ---
    success = _try_vesselboost_docker(preprocessed_path, output_dir, job_id, mask_path)
    if success:
        logger.info("VesselBoost (Docker) segmentation completed successfully.")
        return str(mask_path), warnings

    # --- Fallback: threshold-based segmentation ---
    logger.warning("VesselBoost not available. Using threshold-based fallback.")
    warnings.append(
        "VesselBoost not available; using Otsu threshold + morphological "
        "cleanup as fallback. Segmentation quality may be reduced, "
        "especially for small vessels."
    )
    _threshold_segmentation(preprocessed_path, mask_path)
    return str(mask_path), warnings


def _try_vesselboost(
    input_path: str | Path,
    output_dir: str | Path,
    job_id: str,
    mask_path: str | Path,
) -> bool:
    """
    Try running VesselBoost locally via its Python scripts.

    VesselBoost pipeline:
        1. prediction.py — initial segmentation with pretrained model
        2. test_time_adaptation.py — TTA to refine segmentation

    Returns True if successful.
    """
    prediction_script = VESSELBOOST_DIR / "prediction.py"
    tta_script = VESSELBOOST_DIR / "test_time_adaptation.py"

    if not prediction_script.exists():
        logger.info(f"VesselBoost not found at {VESSELBOOST_DIR}")
        return False

    try:
        # Add VesselBoost directory to PYTHONPATH so it can find its 'library' package
        env = os.environ.copy()
        env["PYTHONPATH"] = str(VESSELBOOST_DIR) + os.pathsep + env.get("PYTHONPATH", "")

        # Step 1: Initial prediction
        logger.info("Running VesselBoost prediction...")
        prediction_output = Path(output_dir) / f"{job_id}_vb_prediction"
        prediction_output.mkdir(parents=True, exist_ok=True)

        cmd_predict = [
            sys.executable, str(prediction_script),
            "--image_path", str(input_path),
            "--output_path", str(prediction_output),
            "--pretrained", str(VESSELBOOST_MODEL_DIR / "BM_VB2_aug_all_ep2k_bat_10_0903"),
            "--prep_mode", "4",
        ]
        result = subprocess.run(
            cmd_predict, capture_output=True, text=True, timeout=1800, env=env
        )
        if result.returncode != 0:
            logger.warning(f"VesselBoost prediction failed: {result.stderr[:500]}")
            return False

        # Find the prediction output file
        pred_files = list(prediction_output.glob("*.nii*"))
        if not pred_files:
            logger.warning("VesselBoost prediction produced no output files.")
            return False
        pred_file = pred_files[0]

        # Step 2: Test-time adaptation
        logger.info("Running VesselBoost test-time adaptation...")
        tta_output = Path(output_dir) / f"{job_id}_vb_tta"
        tta_output.mkdir(parents=True, exist_ok=True)

        cmd_tta = [
            sys.executable, str(tta_script),
            "--image_path", str(input_path),
            "--output_path", str(tta_output),
            "--pretrained", str(VESSELBOOST_MODEL_DIR / "BM_VB2_aug_all_ep2k_bat_10_0903"),
            "--proxy", str(pred_file),
        ]
        result = subprocess.run(
            cmd_tta, capture_output=True, text=True, timeout=3600, env=env
        )

        # Use TTA output if available, otherwise use prediction output
        if result.returncode == 0:
            tta_files = list(tta_output.glob("*.nii*"))
            final_file = tta_files[0] if tta_files else pred_file
        else:
            logger.warning(
                f"VesselBoost TTA failed (using prediction only): {result.stderr[:300]}"
            )
            final_file = pred_file

        # Binarize and save as the mask
        img = load_nifti(final_file)
        data = get_data(img)
        binary_mask = (data > 0.5).astype(np.uint8)
        save_nifti(binary_mask, img.affine, mask_path, header=img.header)
        return True

    except subprocess.TimeoutExpired:
        logger.warning("VesselBoost timed out.")
        return False
    except Exception as exc:
        logger.warning(f"VesselBoost error: {exc}")
        return False


def _try_vesselboost_docker(
    input_path: str | Path,
    output_dir: str | Path,
    job_id: str,
    mask_path: str | Path,
) -> bool:
    """
    Try running VesselBoost via Docker container (vnmd/vesselboost_2.0.1).

    Returns True if successful.
    """
    if shutil.which("docker") is None:
        logger.info("Docker not available for VesselBoost container.")
        return False

    try:
        input_path = Path(input_path).resolve()
        output_dir = Path(output_dir).resolve()

        cmd = [
            "docker", "run", "--rm",
            "-v", f"{input_path.parent}:/input",
            "-v", f"{output_dir}:/output",
            "vnmd/vesselboost_2.0.1",
            "prediction.py",
            "--image_path", f"/input/{input_path.name}",
            "--output_path", "/output",
            "--prep_mode", "4",
        ]

        logger.info(f"Running VesselBoost Docker: {' '.join(cmd)}")
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=3600
        )

        if result.returncode != 0:
            logger.warning(f"VesselBoost Docker failed: {result.stderr[:500]}")
            return False

        # Find output and binarize
        output_files = list(output_dir.glob(f"*prediction*"))
        if not output_files:
            output_files = list(output_dir.glob("*.nii*"))
        if not output_files:
            return False

        img = load_nifti(output_files[0])
        data = get_data(img)
        binary_mask = (data > 0.5).astype(np.uint8)
        save_nifti(binary_mask, img.affine, mask_path, header=img.header)
        return True

    except Exception as exc:
        logger.warning(f"VesselBoost Docker error: {exc}")
        return False


def _threshold_segmentation(
    input_path: str | Path,
    output_path: str | Path,
) -> None:
    """
    Fallback vessel segmentation using multi-level Otsu thresholding
    and morphological operations.

    Designed for TOF-MRA where vessels appear hyperintense.
    """
    from scipy import ndimage
    from skimage.filters import threshold_multiotsu
    from skimage.morphology import remove_small_objects

    logger.info("Running fallback threshold-based vessel segmentation...")

    img = load_nifti(input_path)
    data = get_data(img)

    # Use only non-zero voxels for thresholding
    nonzero_data = data[data > 0]
    if len(nonzero_data) == 0:
        # Empty image — save empty mask
        save_nifti(
            np.zeros(data.shape, dtype=np.uint8),
            img.affine, output_path, header=img.header
        )
        return

    # Multi-level Otsu to find the vessel intensity class (highest)
    try:
        thresholds = threshold_multiotsu(nonzero_data, classes=3)
        vessel_threshold = thresholds[-1]  # Vessels are brightest in TOF-MRA
    except ValueError:
        # Fall back to simple Otsu if multi-Otsu fails
        from skimage.filters import threshold_otsu
        vessel_threshold = threshold_otsu(nonzero_data)

    # Binarize
    vessel_mask = data > vessel_threshold

    # Morphological cleanup
    vessel_mask = ndimage.binary_closing(vessel_mask, iterations=1)
    vessel_mask = ndimage.binary_opening(vessel_mask, iterations=1)

    # Remove small objects (noise)
    vessel_mask = remove_small_objects(vessel_mask, min_size=50)

    save_nifti(
        vessel_mask.astype(np.uint8),
        img.affine, output_path, header=img.header
    )
    logger.info(f"Fallback segmentation saved: {output_path}")
    logger.info(f"  Vessel voxels: {vessel_mask.sum():,} / {data.size:,}")
