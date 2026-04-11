"""
nifti_utils.py — NIfTI file I/O helpers and coordinate transformations.

Centralizes all nibabel interactions and provides consistent
loading, saving, and voxel-to-world coordinate conversion.
"""

import logging
from pathlib import Path
from typing import Optional

import nibabel as nib
import numpy as np

logger = logging.getLogger(__name__)


def load_nifti(path: str | Path) -> nib.Nifti1Image:
    """
    Load a NIfTI file from disk.

    Args:
        path: Path to .nii or .nii.gz file.

    Returns:
        nibabel Nifti1Image object.

    Raises:
        FileNotFoundError: If the file does not exist.
        nibabel.filebasedimages.ImageFileError: If the file is not a valid NIfTI.
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"NIfTI file not found: {path}")
    logger.info(f"Loading NIfTI: {path}")
    img = nib.load(str(path))
    logger.info(
        f"  Shape: {img.shape}, Voxel size: {get_voxel_size(img)}, "
        f"Datatype: {img.get_data_dtype()}"
    )
    return img


def save_nifti(
    data: np.ndarray,
    affine: np.ndarray,
    path: str | Path,
    header: Optional[nib.Nifti1Header] = None,
) -> Path:
    """
    Save a numpy array as a NIfTI file.

    Args:
        data: 3D (or 4D) numpy array of voxel data.
        affine: 4×4 affine transformation matrix.
        path: Output file path (.nii or .nii.gz).
        header: Optional NIfTI header to preserve metadata.

    Returns:
        Path to the saved file.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    img = nib.Nifti1Image(data, affine, header=header)
    nib.save(img, str(path))
    logger.info(f"Saved NIfTI: {path} (shape={data.shape})")
    return path


def get_voxel_size(img: nib.Nifti1Image) -> tuple[float, ...]:
    """
    Get the voxel dimensions in mm from a NIfTI image.

    Args:
        img: nibabel Nifti1Image.

    Returns:
        Tuple of voxel sizes (x, y, z) in mm.
    """
    return tuple(float(v) for v in img.header.get_zooms()[:3])


def get_data(img: nib.Nifti1Image) -> np.ndarray:
    """
    Get the voxel data as a float64 numpy array.

    Args:
        img: nibabel Nifti1Image.

    Returns:
        3D numpy array of voxel intensities.
    """
    return np.asarray(img.dataobj, dtype=np.float64)


def voxel_to_world(
    voxel_coords: np.ndarray,
    affine: np.ndarray,
) -> np.ndarray:
    """
    Convert voxel coordinates to world (scanner/MNI) coordinates.

    Args:
        voxel_coords: Array of shape (N, 3) with voxel indices.
        affine: 4×4 affine matrix.

    Returns:
        Array of shape (N, 3) with world coordinates in mm.
    """
    voxel_coords = np.atleast_2d(voxel_coords)
    ones = np.ones((voxel_coords.shape[0], 1))
    voxel_h = np.hstack([voxel_coords, ones])  # homogeneous coords
    world_h = voxel_h @ affine.T
    return world_h[:, :3]


def world_to_voxel(
    world_coords: np.ndarray,
    affine: np.ndarray,
) -> np.ndarray:
    """
    Convert world coordinates to voxel indices.

    Args:
        world_coords: Array of shape (N, 3) with world coordinates in mm.
        affine: 4×4 affine matrix.

    Returns:
        Array of shape (N, 3) with voxel indices (float; round for integer indexing).
    """
    world_coords = np.atleast_2d(world_coords)
    inv_affine = np.linalg.inv(affine)
    ones = np.ones((world_coords.shape[0], 1))
    world_h = np.hstack([world_coords, ones])
    voxel_h = world_h @ inv_affine.T
    return voxel_h[:, :3]


def is_isotropic(img: nib.Nifti1Image, target_mm: float, tol: float = 0.01) -> bool:
    """
    Check whether a NIfTI image has the target isotropic resolution.

    Args:
        img: nibabel Nifti1Image.
        target_mm: Desired voxel size in mm.
        tol: Tolerance for comparison.

    Returns:
        True if all voxel dimensions are within tolerance of target_mm.
    """
    voxel_size = get_voxel_size(img)
    return all(abs(v - target_mm) < tol for v in voxel_size)
