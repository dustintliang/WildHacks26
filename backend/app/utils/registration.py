"""
registration.py — MNI152 registration utilities.

Provides functions to register subject-space images to MNI152 standard
space using nilearn, and to create coordinate transforms between spaces.
"""

import logging
from pathlib import Path
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)


def register_to_mni(
    input_path: str | Path,
    output_dir: Optional[str | Path] = None,
) -> tuple[str, np.ndarray, np.ndarray]:
    """
    Register a NIfTI image to MNI152 standard space using nilearn.

    Uses nilearn's MNI152 template and resample_to_img for affine
    registration. For production use, ANTs would provide better results
    but nilearn works as a dependency-light fallback.

    Args:
        input_path: Path to the subject-space NIfTI file.
        output_dir: Directory to save the registered image. If None,
                     saves alongside the input file.

    Returns:
        Tuple of:
            - Path to the registered NIfTI file
            - Forward affine transform (subject → MNI)
            - Inverse affine transform (MNI → subject)
    """
    import nibabel as nib
    from nilearn import datasets, image

    input_path = Path(input_path)
    if output_dir is None:
        output_dir = input_path.parent
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    logger.info(f"Registering {input_path.name} to MNI152 space...")

    # Load subject image
    subject_img = nib.load(str(input_path))
    subject_affine = subject_img.affine

    # Load MNI152 template
    mni_template = datasets.load_mni152_template(resolution=1)
    mni_affine = mni_template.affine

    # Resample subject to MNI space
    registered_img = image.resample_to_img(
        source_img=subject_img,
        target_img=mni_template,
        interpolation="continuous",
    )

    # Save registered image
    output_path = output_dir / f"{input_path.stem.replace('.nii', '')}_mni.nii.gz"
    nib.save(registered_img, str(output_path))
    logger.info(f"Registered image saved to: {output_path}")

    # Compute transforms
    # Forward: subject voxel → world → MNI voxel (approximate affine mapping)
    forward_transform = np.linalg.inv(mni_affine) @ subject_affine
    inverse_transform = np.linalg.inv(forward_transform)

    return str(output_path), forward_transform, inverse_transform


def get_mni_template_img():
    """
    Load and return the MNI152 template as a nibabel image.

    Returns:
        nibabel Nifti1Image of the MNI152 template at 1mm resolution.
    """
    from nilearn import datasets
    return datasets.load_mni152_template(resolution=1)


def voxel_to_mni(
    voxel_coords: np.ndarray,
    subject_affine: np.ndarray,
) -> np.ndarray:
    """
    Convert subject voxel coordinates to approximate MNI world coordinates.

    This is a simplified transform that assumes the subject affine
    roughly maps to MNI space (which is approximately true for
    reoriented images). For precise mapping, use the full registration
    transform from register_to_mni().

    Args:
        voxel_coords: Array of shape (N, 3) in voxel space.
        subject_affine: 4×4 affine from the subject NIfTI.

    Returns:
        Array of shape (N, 3) in MNI world coordinates (mm).
    """
    from app.utils.nifti_utils import voxel_to_world
    return voxel_to_world(voxel_coords, subject_affine)


def mni_coords_to_roi_mask(
    mni_img_shape: tuple,
    mni_affine: np.ndarray,
    roi_ranges: dict,
) -> np.ndarray:
    """
    Create a binary ROI mask in MNI space from coordinate ranges.

    Args:
        mni_img_shape: Shape of the MNI-space image (x, y, z).
        mni_affine: 4×4 affine of the MNI-space image.
        roi_ranges: Dictionary with 'x_range', 'y_range', 'z_range'
                     each being (min_mm, max_mm) in MNI coordinates.

    Returns:
        Boolean 3D numpy array (mask) with True inside the ROI.
    """
    # Create coordinate grids in MNI world space
    i_coords = np.arange(mni_img_shape[0])
    j_coords = np.arange(mni_img_shape[1])
    k_coords = np.arange(mni_img_shape[2])

    # Convert voxel grid to world coordinates
    ii, jj, kk = np.meshgrid(i_coords, j_coords, k_coords, indexing="ij")
    voxels = np.stack([ii.ravel(), jj.ravel(), kk.ravel()], axis=1)

    from app.utils.nifti_utils import voxel_to_world
    world = voxel_to_world(voxels, mni_affine)

    x, y, z = world[:, 0], world[:, 1], world[:, 2]

    x_min, x_max = roi_ranges["x_range"]
    y_min, y_max = roi_ranges["y_range"]
    z_min, z_max = roi_ranges["z_range"]

    mask_flat = (
        (x >= x_min) & (x <= x_max) &
        (y >= y_min) & (y <= y_max) &
        (z >= z_min) & (z <= z_max)
    )

    return mask_flat.reshape(mni_img_shape)
