"""
step1_preprocess.py — Skull-stripping, intensity normalization, and resampling.

Pipeline Step 1:
    1. Skull-strip the raw NIfTI using HD-BET (fallback: FSL BET)
    2. Intensity normalize to zero mean, unit variance
    3. Resample to 0.5mm isotropic resolution if needed
    4. Save the preprocessed NIfTI as an intermediate file
"""

import logging
import shutil
import subprocess
import tempfile
from pathlib import Path

import nibabel as nib
import numpy as np
from nilearn import image as nl_image

from app.config import TARGET_RESOLUTION_MM
from app.utils.nifti_utils import get_data, get_voxel_size, is_isotropic, load_nifti, save_nifti

logger = logging.getLogger(__name__)


def preprocess(
    input_path: str | Path,
    output_dir: str | Path,
    job_id: str,
) -> tuple[str, list[str]]:
    """
    Run the full preprocessing pipeline on a raw NIfTI TOF-MRA.

    Args:
        input_path: Path to the raw input NIfTI file.
        output_dir: Directory for output files.
        job_id: Unique job identifier.

    Returns:
        Tuple of (path to preprocessed NIfTI, list of warning messages).
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    warnings: list[str] = []

    # --- 1. Skull stripping ---
    logger.info("Step 1.1: Skull stripping...")
    skull_stripped_path, strip_warnings = _skull_strip(input_path, output_dir, job_id)
    warnings.extend(strip_warnings)

    # --- 2. Intensity normalization ---
    logger.info("Step 1.2: Intensity normalization (zero mean, unit variance)...")
    img = load_nifti(skull_stripped_path)
    data = get_data(img)

    # Only normalize non-zero voxels (brain region)
    brain_mask = data > 0
    if brain_mask.sum() > 0:
        brain_vals = data[brain_mask]
        mean_val = brain_vals.mean()
        std_val = brain_vals.std()
        if std_val > 0:
            data[brain_mask] = (brain_vals - mean_val) / std_val
        else:
            warnings.append("Standard deviation of brain voxels is zero; skipped normalization.")
    else:
        warnings.append("No non-zero voxels found after skull stripping; normalization skipped.")

    normalized_path = output_dir / f"{job_id}_normalized.nii.gz"
    save_nifti(data, img.affine, normalized_path, header=img.header)

    # --- 3. Resample to isotropic resolution ---
    logger.info(f"Step 1.3: Checking resolution (target: {TARGET_RESOLUTION_MM}mm isotropic)...")
    norm_img = load_nifti(normalized_path)

    if is_isotropic(norm_img, TARGET_RESOLUTION_MM):
        logger.info("  Already at target resolution — no resampling needed.")
        preprocessed_path = str(normalized_path)
    else:
        current_voxels = get_voxel_size(norm_img)
        logger.info(
            f"  Current voxels: {current_voxels} → "
            f"resampling to {TARGET_RESOLUTION_MM}mm isotropic"
        )
        preprocessed_path = str(
            output_dir / f"{job_id}_preprocessed.nii.gz"
        )
        resampled_img = _resample_isotropic(norm_img, TARGET_RESOLUTION_MM)
        nib.save(resampled_img, preprocessed_path)
        logger.info(f"  Resampled image saved: {preprocessed_path}")

    return preprocessed_path, warnings


def _skull_strip(
    input_path: str | Path,
    output_dir: str | Path,
    job_id: str,
) -> tuple[str, list[str]]:
    """
    Attempt skull stripping with HD-BET, falling back to FSL BET.

    Returns:
        Tuple of (path to skull-stripped NIfTI, list of warnings).
    """
    input_path = Path(input_path)
    output_dir = Path(output_dir)
    warnings: list[str] = []

    output_path = output_dir / f"{job_id}_brain.nii.gz"

    # --- Try HD-BET ---
    if shutil.which("hd-bet") is not None:
        logger.info("  Using HD-BET for skull stripping...")
        try:
            cmd = [
                "hd-bet",
                "-i", str(input_path),
                "-o", str(output_path),
            ]
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=600
            )
            if result.returncode == 0 and output_path.exists():
                logger.info("  HD-BET completed successfully.")
                return str(output_path), warnings
            else:
                logger.warning(f"  HD-BET failed: {result.stderr}")
                warnings.append(f"HD-BET failed: {result.stderr[:200]}")
        except subprocess.TimeoutExpired:
            logger.warning("  HD-BET timed out after 600s.")
            warnings.append("HD-BET timed out; falling back to FSL BET.")
        except Exception as exc:
            logger.warning(f"  HD-BET error: {exc}")
            warnings.append(f"HD-BET error: {exc}")
    else:
        logger.info("  HD-BET not found, trying FSL BET...")
        warnings.append("HD-BET not installed; attempting FSL BET fallback.")

    # --- Try FSL BET ---
    if shutil.which("bet") is not None:
        logger.info("  Using FSL BET for skull stripping...")
        try:
            cmd = [
                "bet",
                str(input_path),
                str(output_path),
                "-R",  # robust brain centre estimation
                "-f", "0.3",  # fractional intensity threshold
                "-g", "0",
            ]
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=300
            )
            if result.returncode == 0 and output_path.exists():
                logger.info("  FSL BET completed successfully.")
                return str(output_path), warnings
            else:
                logger.warning(f"  FSL BET failed: {result.stderr}")
                warnings.append(f"FSL BET failed: {result.stderr[:200]}")
        except Exception as exc:
            logger.warning(f"  FSL BET error: {exc}")
            warnings.append(f"FSL BET error: {exc}")
    else:
        warnings.append("FSL BET not installed either.")

    # --- Final fallback: simple intensity-based masking ---
    logger.warning("  No skull-stripping tool available. Using intensity-based fallback.")
    warnings.append(
        "Neither HD-BET nor FSL BET available; using basic intensity thresholding "
        "for brain extraction. Results may be less accurate."
    )
    _intensity_based_extraction(input_path, output_path)
    return str(output_path), warnings


def _intensity_based_extraction(
    input_path: str | Path,
    output_path: str | Path,
) -> None:
    """
    Simple fallback brain extraction using Otsu thresholding
    and morphological operations.
    """
    from scipy import ndimage
    from skimage.filters import threshold_otsu

    img = load_nifti(input_path)
    data = get_data(img)

    # Otsu threshold to find rough brain mask
    threshold = threshold_otsu(data[data > 0]) if data.max() > 0 else 0
    brain_mask = data > threshold * 0.3

    # Morphological cleanup: fill holes, remove small objects
    brain_mask = ndimage.binary_fill_holes(brain_mask)
    brain_mask = ndimage.binary_opening(brain_mask, iterations=2)
    brain_mask = ndimage.binary_closing(brain_mask, iterations=2)

    # Keep only largest connected component
    labeled, num_features = ndimage.label(brain_mask)
    if num_features > 1:
        component_sizes = ndimage.sum(brain_mask, labeled, range(1, num_features + 1))
        largest = np.argmax(component_sizes) + 1
        brain_mask = labeled == largest

    # Apply mask
    masked_data = data * brain_mask
    save_nifti(masked_data.astype(np.float32), img.affine, output_path, header=img.header)
    logger.info(f"  Fallback brain extraction saved: {output_path}")


def _resample_isotropic(
    img: nib.Nifti1Image,
    target_mm: float,
) -> nib.Nifti1Image:
    """
    Resample a NIfTI image to isotropic voxel resolution.

    Args:
        img: Input nibabel image.
        target_mm: Target voxel size in mm (isotropic).

    Returns:
        Resampled nibabel image.
    """
    target_affine = np.diag([target_mm, target_mm, target_mm, 1.0])
    # Copy rotation from original affine, only change voxel sizes
    orig_affine = img.affine.copy()
    # Extract rotation/direction from original
    voxel_sizes = np.array(get_voxel_size(img))
    scaling = np.diag(1.0 / voxel_sizes)
    rotation = orig_affine[:3, :3] @ scaling
    # Build new affine with original rotation but target voxel size
    new_affine = np.eye(4)
    new_affine[:3, :3] = rotation * target_mm
    new_affine[:3, 3] = orig_affine[:3, 3]  # preserve origin

    resampled = nl_image.resample_img(
        img,
        target_affine=new_affine,
        interpolation="continuous",
    )
    return resampled
