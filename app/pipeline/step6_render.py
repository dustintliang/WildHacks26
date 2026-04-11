"""
step6_render.py — 2D slice rendering with vessel overlays.

Pipeline Step 6:
    For each named artery that has at least one flagged feature,
    generate axial + coronal PNG overlays:
        - Original scan as grayscale background
        - Colored vessel mask overlay
        - Flagged locations marked in red
    Save PNGs keyed by artery name.
"""

import logging
from pathlib import Path
from typing import Any

import matplotlib
matplotlib.use("Agg")  # Non-interactive backend for server use
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import ListedColormap

from app.config import ARTERY_NAMES, EICAB_LABEL_MAP
from app.models import SliceImages
from app.utils.nifti_utils import get_data, load_nifti

logger = logging.getLogger(__name__)

# Color map for different arteries (RGBA)
_ARTERY_COLORS: dict[str, tuple[float, ...]] = {
    "left_ICA":       (0.2, 0.6, 1.0, 0.5),   # Blue
    "right_ICA":      (0.0, 0.4, 0.8, 0.5),   # Dark blue
    "left_MCA":       (0.0, 0.8, 0.4, 0.5),   # Green
    "right_MCA":      (0.0, 0.6, 0.2, 0.5),   # Dark green
    "left_ACA":       (1.0, 0.8, 0.0, 0.5),   # Yellow
    "right_ACA":      (0.8, 0.6, 0.0, 0.5),   # Dark yellow
    "left_PCA":       (0.8, 0.2, 0.8, 0.5),   # Purple
    "right_PCA":      (0.6, 0.0, 0.6, 0.5),   # Dark purple
    "basilar":        (1.0, 0.5, 0.0, 0.5),   # Orange
    "left_vertebral": (0.4, 0.8, 0.8, 0.5),   # Teal
    "right_vertebral":(0.2, 0.6, 0.6, 0.5),   # Dark teal
}

_FLAG_COLOR = (1.0, 0.0, 0.0, 0.9)  # Red for flagged locations


def render_slices(
    original_nifti_path: str | Path,
    vessel_mask_path: str | Path,
    labeled_nifti_path: str | Path,
    artery_dict: dict[str, np.ndarray | None],
    features: dict[str, Any],
    output_dir: str | Path,
    job_id: str,
) -> dict[str, SliceImages]:
    """
    Render axial and coronal PNG overlays for arteries with flagged features.

    Args:
        original_nifti_path: Path to preprocessed NIfTI (grayscale background).
        vessel_mask_path: Path to binary vessel mask.
        labeled_nifti_path: Path to labeled artery NIfTI.
        artery_dict: Dict mapping artery name → voxel indices or None.
        features: Dict with keys 'stenosis', 'aneurysms', 'tortuosity'
                  containing per-artery feature results.
        output_dir: Directory for output PNGs.
        job_id: Unique job identifier.

    Returns:
        Dict mapping artery name → SliceImages with paths to PNGs.
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Load images
    orig_img = load_nifti(original_nifti_path)
    orig_data = get_data(orig_img)
    mask_data = get_data(load_nifti(vessel_mask_path))
    labeled_data = get_data(load_nifti(labeled_nifti_path))

    # Normalize original for display
    if orig_data.max() > orig_data.min():
        display_data = (orig_data - orig_data.min()) / (orig_data.max() - orig_data.min())
    else:
        display_data = np.zeros_like(orig_data)

    slice_images: dict[str, SliceImages] = {}

    for artery_name in ARTERY_NAMES:
        voxels = artery_dict.get(artery_name)
        if voxels is None:
            continue

        # Check if this artery has any flagged features
        has_flags = _artery_has_flags(artery_name, features)
        if not has_flags:
            continue

        logger.info(f"Rendering slices for {artery_name}...")

        # Determine the best slice indices (center of the artery)
        center_voxel = np.mean(voxels, axis=0).astype(int)

        # Get flagged locations for red markers
        flag_coords = _get_flag_coordinates(artery_name, features)

        # Find slice at flagged location if available, otherwise artery center
        if flag_coords:
            slice_center = np.mean(flag_coords, axis=0).astype(int)
        else:
            slice_center = center_voxel

        # Ensure indices are in bounds
        slice_center = np.clip(
            slice_center,
            [0, 0, 0],
            [s - 1 for s in orig_data.shape]
        )

        artery_color = _ARTERY_COLORS.get(
            artery_name, (0.5, 0.5, 0.5, 0.5)
        )

        # --- Axial slice (z-plane) ---
        axial_path = output_dir / f"{job_id}_{artery_name}_axial.png"
        _render_slice(
            display_data, mask_data, labeled_data, voxels,
            slice_idx=int(slice_center[2]),
            plane="axial",
            artery_color=artery_color,
            flag_coords=flag_coords,
            output_path=axial_path,
            title=f"{artery_name} — Axial",
        )

        # --- Coronal slice (y-plane) ---
        coronal_path = output_dir / f"{job_id}_{artery_name}_coronal.png"
        _render_slice(
            display_data, mask_data, labeled_data, voxels,
            slice_idx=int(slice_center[1]),
            plane="coronal",
            artery_color=artery_color,
            flag_coords=flag_coords,
            output_path=coronal_path,
            title=f"{artery_name} — Coronal",
        )

        slice_images[artery_name] = SliceImages(
            axial=str(axial_path),
            coronal=str(coronal_path),
        )

    logger.info(f"Rendered slices for {len(slice_images)} arteries.")
    return slice_images


def _artery_has_flags(artery_name: str, features: dict) -> bool:
    """Check if an artery has any flagged features."""
    # Check stenosis
    stenosis = features.get("stenosis", {}).get(artery_name, [])
    if stenosis:
        return True

    # Check aneurysms
    aneurysms = features.get("aneurysms", {}).get(artery_name, [])
    if aneurysms:
        return True

    # Check tortuosity
    tortuosity = features.get("tortuosity", {}).get(artery_name)
    if tortuosity and hasattr(tortuosity, "flagged") and tortuosity.flagged:
        return True

    return False


def _get_flag_coordinates(
    artery_name: str,
    features: dict,
) -> list[np.ndarray]:
    """Get voxel coordinates of all flagged features for an artery."""
    coords = []

    # Stenosis locations
    for s in features.get("stenosis", {}).get(artery_name, []):
        if hasattr(s, "voxel_coordinates"):
            coords.append(np.array(s.voxel_coordinates))

    # Aneurysm locations
    for a in features.get("aneurysms", {}).get(artery_name, []):
        if hasattr(a, "bifurcation_voxel_coords"):
            coords.append(np.array(a.bifurcation_voxel_coords))

    return coords


def _render_slice(
    display_data: np.ndarray,
    mask_data: np.ndarray,
    labeled_data: np.ndarray,
    artery_voxels: np.ndarray,
    slice_idx: int,
    plane: str,
    artery_color: tuple[float, ...],
    flag_coords: list[np.ndarray],
    output_path: Path,
    title: str,
) -> None:
    """
    Render a single 2D slice with vessel overlay and flag markers.
    """
    fig, ax = plt.subplots(1, 1, figsize=(8, 8), dpi=120)
    fig.patch.set_facecolor("black")
    ax.set_facecolor("black")

    # Extract 2D slices based on plane
    if plane == "axial":
        bg_slice = display_data[:, :, slice_idx].T
        mask_slice = mask_data[:, :, slice_idx].T
    elif plane == "coronal":
        bg_slice = display_data[:, slice_idx, :].T
        mask_slice = mask_data[:, slice_idx, :].T
    else:  # sagittal
        bg_slice = display_data[slice_idx, :, :].T
        mask_slice = mask_data[slice_idx, :, :].T

    # Display grayscale background
    ax.imshow(bg_slice, cmap="gray", aspect="equal", origin="lower")

    # Vessel mask overlay
    vessel_overlay = np.zeros((*bg_slice.shape, 4))
    vessel_region = mask_slice > 0
    vessel_overlay[vessel_region] = artery_color
    ax.imshow(vessel_overlay, aspect="equal", origin="lower")

    # Flag markers (red circles)
    for coord in flag_coords:
        coord = coord.astype(int)
        if plane == "axial":
            if 0 <= coord[2] - slice_idx <= 2:  # within ±2 slices
                ax.plot(
                    coord[0], coord[1], "o",
                    color="red", markersize=12,
                    markeredgecolor="white", markeredgewidth=1.5,
                )
        elif plane == "coronal":
            if abs(coord[1] - slice_idx) <= 2:
                ax.plot(
                    coord[0], coord[2], "o",
                    color="red", markersize=12,
                    markeredgecolor="white", markeredgewidth=1.5,
                )

    ax.set_title(title, color="white", fontsize=14, pad=10)
    ax.axis("off")

    plt.tight_layout()
    plt.savefig(
        output_path, bbox_inches="tight",
        facecolor="black", edgecolor="none",
        dpi=120,
    )
    plt.close(fig)
    logger.info(f"  Saved: {output_path}")
