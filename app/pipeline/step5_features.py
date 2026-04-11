"""
step5_features.py — Feature extraction for all named arteries.

Pipeline Step 5:
    5a. Stenosis detection (NASCET criteria)
    5b. Aneurysm candidate detection at bifurcations
    5c. Tortuosity metrics (DF and SOAM)
    5d. Small Vessel Disease proxy (vessel density in ROIs)
"""

import logging
from pathlib import Path

import nibabel as nib
import numpy as np
from scipy import ndimage
from skimage.morphology import skeletonize

from app.config import (
    ANEURYSM_ASPECT_RATIO,
    ANEURYSM_DEVIATION_STD,
    ANEURYSM_SIZE_RATIO,
    ANEURYSM_WINDOW_MM,
    ARTERY_NAMES,
    MNI_ROI_BASAL_GANGLIA,
    MNI_ROI_CORTICAL_GM,
    MNI_ROI_DEEP_WM,
    REFERENCE_SEGMENT_LENGTH_MM,
    STENOSIS_MODERATE_THRESHOLD,
    STENOSIS_SEVERE_THRESHOLD,
    SVD_RATIO_CUTOFF,
    SVD_SMALL_VESSEL_RADIUS_MM,
    TORTUOSITY_DF_CUTOFF,
    TORTUOSITY_SOAM_PERCENTILE,
)
from app.models import (
    AneurysmCandidate,
    SVDResult,
    StenosisCandidate,
    TortuosityResult,
)
from app.utils.nifti_utils import get_data, get_voxel_size, load_nifti, voxel_to_world

logger = logging.getLogger(__name__)


# ===================================================================
# 5a — Stenosis Detection
# ===================================================================

def compute_stenosis(
    centerline_data: dict[str, dict],
    voxel_size: tuple[float, ...],
    affine: np.ndarray,
) -> dict[str, list[StenosisCandidate]]:
    """
    Compute stenosis for each artery using NASCET criteria.

    For each artery:
        stenosis% = (1 − r_min / r_reference) × 100
        r_reference = mean radius of 10mm proximal segment

    Args:
        centerline_data: Per-artery centerline points, radii, and lengths.
        voxel_size: Voxel dimensions in mm.
        affine: 4×4 affine for coordinate transforms.

    Returns:
        Dict mapping artery name → list of StenosisCandidate.
    """
    results: dict[str, list[StenosisCandidate]] = {}

    for artery_name in ARTERY_NAMES:
        data = centerline_data.get(artery_name, {})
        points = data.get("centerline_points", np.array([]).reshape(0, 3))
        radii = data.get("radii", np.array([]))

        results[artery_name] = []

        if len(radii) < 5 or np.all(radii <= 0):
            continue

        # Find minimum radius point
        min_idx = int(np.argmin(radii))
        r_min = float(radii[min_idx])

        if r_min <= 0:
            continue

        # Compute reference radius: mean of 10mm proximal segment
        r_reference = _compute_reference_radius(
            points, radii, min_idx, voxel_size, REFERENCE_SEGMENT_LENGTH_MM
        )

        if r_reference <= 0 or r_reference <= r_min:
            continue

        # Compute stenosis percentage
        stenosis_pct = (1.0 - r_min / r_reference) * 100.0

        # Classify severity
        if stenosis_pct >= STENOSIS_SEVERE_THRESHOLD:
            severity = "severe"
        elif stenosis_pct >= STENOSIS_MODERATE_THRESHOLD:
            severity = "moderate"
        else:
            severity = "normal"

        # Get coordinates
        voxel_coord = points[min_idx].tolist()
        mni_coord = voxel_to_world(
            np.array([points[min_idx]]), affine
        )[0].tolist()

        # Estimate affected segment length (region where radius < r_reference * 0.8)
        threshold = r_reference * 0.8
        affected = radii < threshold
        affected_length = _compute_path_length(
            points[affected], voxel_size
        ) if np.any(affected) else 0.0

        candidate = StenosisCandidate(
            artery_name=artery_name,
            voxel_coordinates=voxel_coord,
            mni_coordinates=mni_coord,
            stenosis_percent=round(stenosis_pct, 1),
            severity=severity,
            affected_segment_length_mm=round(affected_length, 1),
            r_min=round(r_min, 3),
            r_reference=round(r_reference, 3),
        )

        # Only report if there's meaningful narrowing
        if stenosis_pct >= 20.0:
            results[artery_name].append(candidate)
            logger.info(
                f"  {artery_name}: stenosis={stenosis_pct:.1f}% ({severity})"
            )

    return results


def _compute_reference_radius(
    points: np.ndarray,
    radii: np.ndarray,
    min_idx: int,
    voxel_size: tuple[float, ...],
    reference_length_mm: float,
) -> float:
    """Compute mean radius of the proximal segment before the minimum."""
    if min_idx <= 0:
        # Use distal segment instead
        segment = _get_segment_by_length(
            points, radii, min_idx, +1, voxel_size, reference_length_mm
        )
    else:
        segment = _get_segment_by_length(
            points, radii, min_idx, -1, voxel_size, reference_length_mm
        )

    if len(segment) == 0:
        return float(np.mean(radii))

    return float(np.mean(segment))


def _get_segment_by_length(
    points: np.ndarray,
    radii: np.ndarray,
    start_idx: int,
    direction: int,
    voxel_size: tuple[float, ...],
    target_length_mm: float,
) -> np.ndarray:
    """Get radii along centerline for a given length from start_idx."""
    collected_radii = []
    accumulated_length = 0.0
    idx = start_idx

    while 0 <= idx < len(points) - 1 and accumulated_length < target_length_mm:
        next_idx = idx + direction
        if next_idx < 0 or next_idx >= len(points):
            break
        diff = (points[next_idx] - points[idx]) * np.array(voxel_size)
        step_length = float(np.linalg.norm(diff))
        accumulated_length += step_length
        collected_radii.append(radii[next_idx])
        idx = next_idx

    return np.array(collected_radii) if collected_radii else np.array([])


# ===================================================================
# 5b — Aneurysm Detection
# ===================================================================

def detect_aneurysms(
    centerline_data: dict[str, dict],
    vessel_mask_path: str | Path,
    artery_dict: dict[str, np.ndarray | None],
    voxel_size: tuple[float, ...],
    affine: np.ndarray,
) -> dict[str, list[AneurysmCandidate]]:
    """
    Detect aneurysm candidates at bifurcation points.

    Criteria:
        - Size ratio (local max radius / parent radius) > 1.6
        - Aspect ratio (depth / neck width) > 1.2
        - Convex surface deviation > 2 std from local vessel shape
    """
    mask_img = load_nifti(vessel_mask_path)
    mask_data = get_data(mask_img)
    results: dict[str, list[AneurysmCandidate]] = {}

    # Find branch points in the full vessel skeleton
    full_skeleton = skeletonize((mask_data > 0).astype(np.uint8))
    branch_points = _find_branch_points(full_skeleton)

    logger.info(f"  Found {len(branch_points)} bifurcation points.")

    for artery_name in ARTERY_NAMES:
        results[artery_name] = []
        voxels = artery_dict.get(artery_name)
        if voxels is None:
            continue

        data = centerline_data.get(artery_name, {})
        radii = data.get("radii", np.array([]))
        if len(radii) == 0:
            continue

        parent_radius = float(np.median(radii))
        if parent_radius <= 0:
            continue

        # Check each branch point near this artery
        window_voxels = ANEURYSM_WINDOW_MM / min(voxel_size)

        for bp in branch_points:
            # Is this branch point near the artery?
            dists = np.linalg.norm(voxels - bp, axis=1)
            if dists.min() > window_voxels:
                continue

            # Compute metrics in the window around the branch point
            window_mask = dists <= window_voxels
            local_voxels = voxels[window_mask]

            # Size ratio: local max radius / parent radius
            dt = ndimage.distance_transform_edt(mask_data > 0, sampling=voxel_size)
            local_radii = np.array([dt[v[0], v[1], v[2]] for v in local_voxels])
            max_local_radius = float(local_radii.max()) if len(local_radii) > 0 else 0
            size_ratio = max_local_radius / parent_radius if parent_radius > 0 else 0

            # Aspect ratio: approximate depth / neck width
            aspect_ratio = _estimate_aspect_ratio(
                local_voxels, dt, voxel_size
            )

            # Deviation score: how much local shape deviates from tubular model
            deviation_score = _compute_deviation_score(
                local_voxels, local_radii, parent_radius
            )

            # Determine confidence
            criteria_met = sum([
                size_ratio > ANEURYSM_SIZE_RATIO,
                aspect_ratio > ANEURYSM_ASPECT_RATIO,
                deviation_score > ANEURYSM_DEVIATION_STD,
            ])

            if criteria_met == 0:
                continue

            confidence = (
                "high" if criteria_met >= 2
                else "moderate" if criteria_met == 1
                else "low"
            )

            mni_coord = voxel_to_world(
                np.array([bp.astype(float)]), affine
            )[0].tolist()

            candidate = AneurysmCandidate(
                artery_name=artery_name,
                bifurcation_voxel_coords=bp.tolist(),
                mni_coords=mni_coord,
                size_ratio=round(size_ratio, 2),
                aspect_ratio=round(aspect_ratio, 2),
                deviation_score=round(deviation_score, 2),
                confidence=confidence,
            )
            results[artery_name].append(candidate)
            logger.info(
                f"  {artery_name}: aneurysm candidate at {bp.tolist()} "
                f"(size={size_ratio:.2f}, aspect={aspect_ratio:.2f}, "
                f"dev={deviation_score:.2f}, conf={confidence})"
            )

    return results


def _find_branch_points(skeleton: np.ndarray) -> list[np.ndarray]:
    """
    Find branch points (bifurcations) in a 3D skeleton.

    A branch point is a skeleton voxel with more than 2 neighbors
    in the 26-connected neighborhood.
    """
    # Create a convolution kernel for counting 26-neighbors
    kernel = np.ones((3, 3, 3), dtype=int)
    kernel[1, 1, 1] = 0  # exclude center

    skeleton_binary = (skeleton > 0).astype(int)
    neighbor_count = ndimage.convolve(skeleton_binary, kernel, mode="constant")

    # Branch points: skeleton voxels with >2 neighbors
    branch_mask = skeleton_binary & (neighbor_count > 2)
    branch_points = np.argwhere(branch_mask)

    return [bp for bp in branch_points]


def _estimate_aspect_ratio(
    local_voxels: np.ndarray,
    dt: np.ndarray,
    voxel_size: tuple[float, ...],
) -> float:
    """
    Estimate aspect ratio (depth / neck width) for potential aneurysm.
    Uses PCA to determine principal axis and measure extent.
    """
    if len(local_voxels) < 3:
        return 0.0

    # Scale to mm
    points_mm = local_voxels * np.array(voxel_size)

    # PCA to find principal axes
    centered = points_mm - points_mm.mean(axis=0)
    try:
        cov = np.cov(centered.T)
        eigenvalues = np.linalg.eigvalsh(cov)
        eigenvalues = np.sort(eigenvalues)[::-1]

        if eigenvalues[-1] > 0:
            # Depth ≈ largest extent, neck ≈ smallest
            depth = np.sqrt(eigenvalues[0])
            neck = np.sqrt(eigenvalues[-1])
            return float(depth / neck) if neck > 0 else 0.0
    except np.linalg.LinAlgError:
        pass

    return 0.0


def _compute_deviation_score(
    local_voxels: np.ndarray,
    local_radii: np.ndarray,
    parent_radius: float,
) -> float:
    """
    Compute how much the local vessel shape deviates from
    the expected tubular model (measured in standard deviations).
    """
    if len(local_radii) < 3:
        return 0.0

    # Expected: radii should be close to parent_radius in a tube
    deviations = local_radii - parent_radius
    std_dev = float(np.std(deviations)) if len(deviations) > 1 else 0.0

    if std_dev <= 0:
        return 0.0

    # Score = max deviation / std of normal variation
    max_deviation = float(np.max(np.abs(deviations)))
    score = max_deviation / parent_radius if parent_radius > 0 else 0.0

    return score


# ===================================================================
# 5c — Tortuosity
# ===================================================================

def compute_tortuosity(
    centerline_data: dict[str, dict],
    voxel_size: tuple[float, ...],
) -> dict[str, TortuosityResult]:
    """
    Compute tortuosity metrics for each artery segment.

    Distance Factor (DF) = path length / Euclidean endpoint distance
    SOAM = sum of angular changes / path length

    Returns:
        Dict mapping artery name → TortuosityResult.
    """
    results: dict[str, TortuosityResult] = {}
    all_soam_values: list[float] = []

    # First pass: compute DF and SOAM for all arteries
    raw_metrics: dict[str, tuple[float, float]] = {}

    for artery_name in ARTERY_NAMES:
        data = centerline_data.get(artery_name, {})
        points = data.get("centerline_points", np.array([]).reshape(0, 3))

        if points.shape[0] < 3:
            raw_metrics[artery_name] = (1.0, 0.0)
            continue

        # Scale to mm
        points_mm = points * np.array(voxel_size)

        # Distance Factor
        path_length = data.get("segment_length_mm", 0.0)
        euclidean_dist = float(np.linalg.norm(points_mm[-1] - points_mm[0]))

        df = path_length / euclidean_dist if euclidean_dist > 0 else 1.0

        # Sum of Angles Metric
        soam = _compute_soam(points_mm, path_length)
        all_soam_values.append(soam)

        raw_metrics[artery_name] = (df, soam)

    # Compute SOAM percentile threshold
    if all_soam_values:
        soam_threshold = float(np.percentile(
            all_soam_values, TORTUOSITY_SOAM_PERCENTILE
        ))
    else:
        soam_threshold = float("inf")

    # Second pass: flag segments
    for artery_name in ARTERY_NAMES:
        df, soam = raw_metrics.get(artery_name, (1.0, 0.0))
        flagged = df > TORTUOSITY_DF_CUTOFF or soam > soam_threshold

        results[artery_name] = TortuosityResult(
            distance_factor=round(df, 3),
            soam=round(soam, 4),
            flagged=flagged,
        )

        if flagged:
            logger.info(
                f"  {artery_name}: FLAGGED tortuosity "
                f"(DF={df:.3f}, SOAM={soam:.4f})"
            )

    return results


def _compute_soam(points_mm: np.ndarray, path_length: float) -> float:
    """
    Compute Sum of Angles Metric:
    SOAM = sum(angle between consecutive tangent vectors) / path_length
    """
    if points_mm.shape[0] < 3 or path_length <= 0:
        return 0.0

    # Compute tangent vectors
    tangents = np.diff(points_mm, axis=0)
    norms = np.linalg.norm(tangents, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    tangents_normalized = tangents / norms

    # Compute angles between consecutive tangents
    total_angle = 0.0
    for i in range(len(tangents_normalized) - 1):
        dot = np.clip(
            np.dot(tangents_normalized[i], tangents_normalized[i + 1]),
            -1.0, 1.0
        )
        angle = np.arccos(dot)
        total_angle += angle

    return total_angle / path_length


def get_aggregate_tortuosity(
    tortuosity_results: dict[str, TortuosityResult],
) -> float:
    """Compute whole-brain aggregate tortuosity score (mean DF)."""
    df_values = [
        r.distance_factor for r in tortuosity_results.values()
        if r.distance_factor > 1.0
    ]
    return round(float(np.mean(df_values)), 3) if df_values else 1.0


# ===================================================================
# 5d — Small Vessel Disease Proxy
# ===================================================================

def compute_svd_proxy(
    vessel_mask_path: str | Path,
    preprocessed_path: str | Path,
    centerline_data: dict[str, dict],
) -> tuple[SVDResult, list[str]]:
    """
    Compute Small Vessel Disease proxy metrics.

    - Register to MNI152
    - Define ROIs: deep WM, basal ganglia, cortical GM
    - Compute vessel density per ROI
    - SVD ratio = deep_WM_density / cortical_density
    - Count small vessels (radius < 0.75mm) in deep WM
    """
    warnings: list[str] = []

    try:
        from app.utils.registration import mni_coords_to_roi_mask, register_to_mni

        # Register to MNI
        mni_path, fwd_xfm, inv_xfm = register_to_mni(preprocessed_path)

        # Load registered vessel mask
        mask_img = load_nifti(vessel_mask_path)
        mask_data = get_data(mask_img)

        # Resample vessel mask to MNI space
        from nilearn import image as nl_image
        mni_template = nib.load(mni_path)
        mask_mni = nl_image.resample_to_img(
            mask_img, mni_template, interpolation="nearest"
        )
        mask_mni_data = np.asarray(mask_mni.dataobj)

        # Create ROI masks
        mni_shape = mask_mni_data.shape[:3]
        mni_affine = mask_mni.affine

        deep_wm_roi = mni_coords_to_roi_mask(mni_shape, mni_affine, MNI_ROI_DEEP_WM)
        bg_roi = mni_coords_to_roi_mask(mni_shape, mni_affine, MNI_ROI_BASAL_GANGLIA)
        cortical_roi = mni_coords_to_roi_mask(mni_shape, mni_affine, MNI_ROI_CORTICAL_GM)

        # Compute vessel density per ROI
        deep_wm_density = _compute_roi_density(mask_mni_data, deep_wm_roi)
        bg_density = _compute_roi_density(mask_mni_data, bg_roi)
        cortical_density = _compute_roi_density(mask_mni_data, cortical_roi)

        # SVD ratio
        svd_ratio = (
            deep_wm_density / cortical_density
            if cortical_density > 0 else 0.0
        )

        # Count small vessels in deep WM
        small_vessel_count = _count_small_vessels(
            mask_mni_data, deep_wm_roi, mni_affine
        )

        svd_flag = svd_ratio < SVD_RATIO_CUTOFF

        result = SVDResult(
            deep_wm_density=round(deep_wm_density, 6),
            basal_ganglia_density=round(bg_density, 6),
            cortical_density=round(cortical_density, 6),
            svd_ratio=round(svd_ratio, 4),
            small_vessel_count=small_vessel_count,
            svd_flag=svd_flag,
        )

        logger.info(
            f"  SVD metrics: WM={deep_wm_density:.6f}, BG={bg_density:.6f}, "
            f"Cortical={cortical_density:.6f}, Ratio={svd_ratio:.4f}, "
            f"SmallVessels={small_vessel_count}, Flag={svd_flag}"
        )

        return result, warnings

    except Exception as exc:
        logger.error(f"SVD computation failed: {exc}")
        warnings.append(f"SVD computation failed: {exc}")
        return SVDResult(
            deep_wm_density=0.0,
            basal_ganglia_density=0.0,
            cortical_density=0.0,
            svd_ratio=0.0,
            small_vessel_count=0,
            svd_flag=False,
        ), warnings


def _compute_roi_density(
    vessel_mask: np.ndarray,
    roi_mask: np.ndarray,
) -> float:
    """Compute vessel voxels / total ROI voxels."""
    roi_total = roi_mask.sum()
    if roi_total == 0:
        return 0.0
    vessel_in_roi = ((vessel_mask > 0) & roi_mask).sum()
    return float(vessel_in_roi / roi_total)


def _count_small_vessels(
    vessel_mask: np.ndarray,
    roi_mask: np.ndarray,
    affine: np.ndarray,
) -> int:
    """Count skeleton segments with radius < SVD_SMALL_VESSEL_RADIUS_MM in ROI."""
    # Get vessel voxels in ROI
    roi_vessels = (vessel_mask > 0) & roi_mask

    if roi_vessels.sum() == 0:
        return 0

    # Skeletonize
    skeleton = skeletonize(roi_vessels.astype(np.uint8))

    # Distance transform for radii
    voxel_size = tuple(float(v) for v in nib.affines.voxel_sizes(affine))
    dt = ndimage.distance_transform_edt(vessel_mask > 0, sampling=voxel_size)

    # Count skeleton points with radius below threshold
    skel_points = np.argwhere(skeleton > 0)
    small_count = sum(
        1 for p in skel_points
        if dt[p[0], p[1], p[2]] < SVD_SMALL_VESSEL_RADIUS_MM
    )

    return small_count


def _compute_path_length(
    points: np.ndarray,
    voxel_size: tuple[float, ...],
) -> float:
    """Compute path length of ordered points in mm."""
    if points.shape[0] < 2:
        return 0.0
    points_mm = points * np.array(voxel_size)
    diffs = np.diff(points_mm, axis=0)
    return float(np.sum(np.linalg.norm(diffs, axis=1)))
