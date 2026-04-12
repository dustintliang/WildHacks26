"""
step3_label.py — Circle of Willis artery labeling using eICAB.

Pipeline Step 3:
    Run eICAB on the vessel mask to produce a labeled NIfTI where each
    voxel is assigned to a named artery. Fallback: atlas-based heuristic
    labeling using MNI coordinate regions.

Labels: L/R ICA, L/R MCA, L/R ACA, L/R PCA, basilar, L/R vertebral.
"""

import logging
import os
import shutil
import subprocess
from pathlib import Path

import nibabel as nib
import numpy as np

from app.config import (
    ARTERY_NAMES,
    EICAB_DIR,
    EICAB_LABEL_MAP,
)
from app.utils.nifti_utils import (
    get_data,
    load_nifti,
    save_nifti,
    voxel_to_world,
)

logger = logging.getLogger(__name__)

# MNI coordinate ranges for atlas-based fallback labeling
# These are approximate bounding boxes for each artery in MNI space (mm)
_ARTERY_MNI_REGIONS: dict[str, dict] = {
    "left_ICA": {
        "x_range": (-25, -5), "y_range": (-20, 20), "z_range": (-30, 10),
    },
    "right_ICA": {
        "x_range": (5, 25), "y_range": (-20, 20), "z_range": (-30, 10),
    },
    "left_MCA": {
        "x_range": (-65, -20), "y_range": (-15, 25), "z_range": (0, 30),
    },
    "right_MCA": {
        "x_range": (20, 65), "y_range": (-15, 25), "z_range": (0, 30),
    },
    "left_ACA": {
        "x_range": (-12, 0), "y_range": (10, 55), "z_range": (0, 40),
    },
    "right_ACA": {
        "x_range": (0, 12), "y_range": (10, 55), "z_range": (0, 40),
    },
    "left_PCA": {
        "x_range": (-35, -5), "y_range": (-60, -10), "z_range": (-10, 15),
    },
    "right_PCA": {
        "x_range": (5, 35), "y_range": (-60, -10), "z_range": (-10, 15),
    },
    "basilar": {
        "x_range": (-8, 8), "y_range": (-35, -10), "z_range": (-35, -5),
    },
    "left_vertebral": {
        "x_range": (-20, -3), "y_range": (-40, -20), "z_range": (-50, -25),
    },
    "right_vertebral": {
        "x_range": (3, 20), "y_range": (-40, -20), "z_range": (-50, -25),
    },
}


_EICAB_LOCAL_REQUIRED_COMMANDS = (
    "3dAutobox",
    "antsRegistration",
    "antsApplyTransforms",
)


def label_arteries(
    vessel_mask_path: str | Path,
    original_path: str | Path,
    output_dir: str | Path,
    job_id: str,
) -> tuple[str, dict[str, np.ndarray | None], list[str]]:
    """
    Label each voxel in the vessel mask with a named artery ID.

    Args:
        vessel_mask_path: Path to binary vessel mask NIfTI.
        original_path: Path to the (preprocessed) original NIfTI.
        output_dir: Directory for output files.
        job_id: Unique job identifier.

    Returns:
        Tuple of:
            - Path to labeled NIfTI file
            - Dict mapping artery name → voxel index array (N×3) or None
            - List of warnings
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    warnings: list[str] = []

    labeled_path = output_dir / f"{job_id}_labeled.nii.gz"

    # --- Prefer eICAB via Docker ---
    success = _try_eicab_docker(vessel_mask_path, original_path, output_dir, labeled_path)
    if success:
        logger.info("eICAB (Docker) labeling completed successfully.")
        artery_dict = _extract_artery_dict_from_labeled(labeled_path)
        return str(labeled_path), artery_dict, warnings

    # --- Fallback to local eICAB ---
    success = _try_eicab(vessel_mask_path, original_path, labeled_path)
    if success:
        logger.info("eICAB labeling completed successfully.")
        artery_dict = _extract_artery_dict_from_labeled(labeled_path)
        return str(labeled_path), artery_dict, warnings

    # --- Fallback: atlas-based heuristic labeling ---
    logger.warning("eICAB not available. Using atlas-based fallback labeling.")
    warnings.append(
        "eICAB not available; using atlas-based heuristic labeling in MNI space. "
        "Artery labels are approximate and may be less accurate."
    )
    artery_dict = _atlas_based_labeling(
        vessel_mask_path, original_path, labeled_path
    )
    return str(labeled_path), artery_dict, warnings


def _try_eicab(
    vessel_mask_path: str | Path,
    original_path: str | Path,
    output_path: str | Path,
) -> bool:
    """Try running eICAB locally."""
    eicab_script = EICAB_DIR / "scripts" / "express_cw.py"
    template_dir = EICAB_DIR / "MNI"
    model_dir = EICAB_DIR / "weights" / "labels_18_236"

    required_paths = [eicab_script, template_dir, model_dir]
    if not all(path.exists() for path in required_paths):
        logger.info(f"eICAB assets not found under {EICAB_DIR}")
        return False

    missing_commands = [
        command for command in _EICAB_LOCAL_REQUIRED_COMMANDS
        if shutil.which(command) is None
    ]
    if missing_commands:
        logger.warning(
            "eICAB local prerequisites missing: %s. "
            "Install AFNI/ANTs or use Docker for eICAB.",
            ", ".join(missing_commands),
        )
        return False

    try:
        import sys
        output_path = Path(output_path)
        run_output_dir = output_path.parent / f"{output_path.stem}_eicab"
        run_output_dir.mkdir(parents=True, exist_ok=True)
        prefix = output_path.name.replace(".nii.gz", "").replace(".nii", "")

        env = os.environ.copy()
        project_root = Path(__file__).resolve().parents[2]
        pythonpath_parts = [str(project_root), str(EICAB_DIR)]
        if env.get("PYTHONPATH"):
            pythonpath_parts.append(env["PYTHONPATH"])
        env["PYTHONPATH"] = os.pathsep.join(pythonpath_parts)

        cmd = [
            sys.executable, str(eicab_script),
            str(original_path),
            str(run_output_dir),
            "-f",
            "-t", str(template_dir),
            "-mp", str(model_dir),
            "-m", str(vessel_mask_path),
            "-pp",
            "--experimental_prediction",
            "-vs", "labels_18_236",
            "-p", prefix,
            "-vv",
        ]
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=1200, env=env
        )

        eicab_labeled_path = run_output_dir / f"{prefix}_eICAB_CW.nii.gz"
        if result.returncode == 0 and eicab_labeled_path.exists():
            shutil.copy2(eicab_labeled_path, output_path)
            return True

        stderr = result.stderr.strip()
        stdout = result.stdout.strip()
        logger.warning("eICAB failed.")
        if stdout:
            logger.warning("eICAB stdout:\n%s", stdout)
        if stderr:
            logger.warning("eICAB stderr:\n%s", stderr)
        return False
    except Exception as exc:
        logger.warning(f"eICAB error: {exc}")
        return False


def _try_eicab_docker(
    vessel_mask_path: str | Path,
    original_path: str | Path,
    output_dir: str | Path,
    output_path: str | Path,
) -> bool:
    """Try running eICAB via Docker."""
    if shutil.which("docker") is None:
        return False

    try:
        original_path = Path(original_path).resolve()
        output_dir = Path(output_dir).resolve()
        output_path = Path(output_path)
        prefix = output_path.name.replace(".nii.gz", "").replace(".nii", "")

        cmd = [
            "docker", "run", "--rm",
            "-v", f"{original_path.parent}:/data",
            "-v", f"{output_dir}:/output",
            "felixdumais1/eicab",
            "-t", f"/data/{original_path.name}",
            "-o", "/output",
            "-f",
        ]
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=1200
        )
        eicab_labeled_path = output_dir / f"{original_path.name.replace('.nii.gz', '').replace('.nii', '')}_eICAB_CW.nii.gz"
        if result.returncode == 0 and eicab_labeled_path.exists():
            shutil.copy2(eicab_labeled_path, output_path)
            return True

        logger.warning("eICAB Docker failed.")
        if result.stdout.strip():
            logger.warning("eICAB Docker stdout:\n%s", result.stdout.strip())
        if result.stderr.strip():
            logger.warning("eICAB Docker stderr:\n%s", result.stderr.strip())
        return False
    except Exception as exc:
        logger.warning(f"eICAB Docker error: {exc}")
        return False


def _extract_artery_dict_from_labeled(
    labeled_path: str | Path,
) -> dict[str, np.ndarray | None]:
    """
    Extract per-artery voxel indices from a labeled NIfTI.

    Returns dict mapping artery name → (N, 3) array of voxel indices,
    or None if the artery was not labeled.
    """
    img = load_nifti(labeled_path)
    data = get_data(img).astype(int)

    grouped_labels = _group_eicab_labels()
    artery_dict: dict[str, np.ndarray | None] = {}
    for artery_name in ARTERY_NAMES:
        label_ids = grouped_labels.get(artery_name, [])
        voxels = np.argwhere(np.isin(data, label_ids)) if label_ids else np.empty((0, 3), dtype=int)
        if voxels.shape[0] > 0:
            artery_dict[artery_name] = voxels
            logger.info(f"  {artery_name}: {voxels.shape[0]:,} voxels")
        else:
            artery_dict[artery_name] = None
            logger.info(f"  {artery_name}: not visible")

    return artery_dict


def _group_eicab_labels() -> dict[str, list[int]]:
    """Group one or more upstream label IDs under each pipeline artery name."""
    grouped: dict[str, list[int]] = {}
    for label_id, artery_name in EICAB_LABEL_MAP.items():
        grouped.setdefault(artery_name, []).append(label_id)
    return grouped


def _atlas_based_labeling(
    vessel_mask_path: str | Path,
    original_path: str | Path,
    output_path: str | Path,
) -> dict[str, np.ndarray | None]:
    """
    Fallback: label vessel voxels using approximate MNI coordinate regions.

    1. Register vessel mask to MNI152 space
    2. For each artery, find vessel voxels within its MNI bounding box
    3. Handle overlapping regions with a priority scheme
    """
    from app.utils.registration import register_to_mni

    logger.info("Running atlas-based artery labeling...")

    # Register to MNI space
    try:
        mni_path, forward_xfm, inverse_xfm = register_to_mni(original_path)
    except Exception as exc:
        logger.warning(f"MNI registration failed: {exc}. Using native space.")
        # Use native space as fallback
        mni_path = original_path
        forward_xfm = np.eye(4)

    # Load vessel mask and the registered image
    mask_img = load_nifti(vessel_mask_path)
    mask_data = get_data(mask_img)
    vessel_voxels = np.argwhere(mask_data > 0)

    if vessel_voxels.shape[0] == 0:
        logger.warning("No vessel voxels found in mask.")
        return {name: None for name in ARTERY_NAMES}

    # Convert vessel voxel coords to MNI world coordinates
    mni_coords = voxel_to_world(vessel_voxels, mask_img.affine)

    # Label image (same shape as mask)
    labeled_data = np.zeros(mask_data.shape, dtype=np.int16)
    artery_dict: dict[str, np.ndarray | None] = {}

    # Assign labels using MNI coordinate ranges. We write one canonical label
    # per artery name so the saved fallback NIfTI is stable across runs.
    grouped_labels = _group_eicab_labels()
    canonical_labels = {
        artery_name: min(label_ids) for artery_name, label_ids in grouped_labels.items()
    }

    for artery_name in reversed(ARTERY_NAMES):
        if artery_name not in _ARTERY_MNI_REGIONS:
            artery_dict[artery_name] = None
            continue

        label_id = canonical_labels[artery_name]
        region = _ARTERY_MNI_REGIONS[artery_name]
        x_min, x_max = region["x_range"]
        y_min, y_max = region["y_range"]
        z_min, z_max = region["z_range"]

        # Find vessel voxels within this MNI region
        in_region = (
            (mni_coords[:, 0] >= x_min) & (mni_coords[:, 0] <= x_max) &
            (mni_coords[:, 1] >= y_min) & (mni_coords[:, 1] <= y_max) &
            (mni_coords[:, 2] >= z_min) & (mni_coords[:, 2] <= z_max)
        )

        region_voxels = vessel_voxels[in_region]

        if region_voxels.shape[0] > 0:
            artery_dict[artery_name] = region_voxels
            for v in region_voxels:
                labeled_data[v[0], v[1], v[2]] = label_id
            logger.info(f"  {artery_name}: {region_voxels.shape[0]:,} voxels")
        else:
            artery_dict[artery_name] = None
            logger.info(f"  {artery_name}: not visible")

    # Save labeled NIfTI
    save_nifti(labeled_data, mask_img.affine, output_path, header=mask_img.header)

    return artery_dict
