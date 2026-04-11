"""
step4_centerline.py — Centerline and radius extraction.

Pipeline Step 4:
    For each labeled artery segment, extract the centerline using VMTK
    (fallback: skimage skeletonize_3d + distance transform).
    At every centerline point, compute local vessel radius.
    Store per-artery: centerline points, radii, segment length in mm.
"""

import logging
from pathlib import Path

import numpy as np
from scipy import ndimage
from scipy.sparse.csgraph import shortest_path
from scipy.spatial.distance import cdist

from app.config import ARTERY_NAMES
from app.utils.nifti_utils import get_data, get_voxel_size, load_nifti

logger = logging.getLogger(__name__)


def extract_centerlines(
    vessel_mask_path: str | Path,
    labeled_nifti_path: str | Path,
    artery_dict: dict[str, np.ndarray | None],
    voxel_size: tuple[float, ...] | None = None,
) -> tuple[dict[str, dict], list[str]]:
    """
    Extract centerlines and radii for each labeled artery.

    Args:
        vessel_mask_path: Path to binary vessel mask NIfTI.
        labeled_nifti_path: Path to labeled artery NIfTI.
        artery_dict: Dict mapping artery name → voxel indices (N×3) or None.
        voxel_size: Voxel dimensions in mm. If None, read from mask image.

    Returns:
        Tuple of:
            - Dict mapping artery name → {
                "centerline_points": np.ndarray (M×3),
                "radii": np.ndarray (M,),
                "segment_length_mm": float,
              }
            - List of warnings
    """
    mask_img = load_nifti(vessel_mask_path)
    mask_data = get_data(mask_img)

    if voxel_size is None:
        voxel_size = get_voxel_size(mask_img)

    warnings: list[str] = []
    centerline_data: dict[str, dict] = {}

    # Check if VMTK is available
    vmtk_available = _check_vmtk()
    if not vmtk_available:
        warnings.append(
            "VMTK not available; using skimage skeletonize + distance transform "
            "for centerline extraction."
        )

    for artery_name in ARTERY_NAMES:
        voxels = artery_dict.get(artery_name)
        if voxels is None or (isinstance(voxels, np.ndarray) and voxels.shape[0] == 0):
            centerline_data[artery_name] = {
                "centerline_points": np.array([]).reshape(0, 3),
                "radii": np.array([]),
                "segment_length_mm": 0.0,
            }
            continue

        logger.info(f"Extracting centerline for {artery_name} ({voxels.shape[0]} voxels)...")

        try:
            # Create binary mask for this artery only
            artery_mask = np.zeros(mask_data.shape, dtype=bool)
            for v in voxels:
                artery_mask[v[0], v[1], v[2]] = True

            if vmtk_available:
                try:
                    points, radii = _vmtk_centerline(artery_mask, voxel_size)
                except Exception as exc:
                    logger.warning(
                        f"  VMTK failed for {artery_name}: {exc}. "
                        f"Falling back to skeletonize."
                    )
                    points, radii = _skeletonize_centerline(
                        artery_mask, mask_data, voxel_size
                    )
            else:
                points, radii = _skeletonize_centerline(
                    artery_mask, mask_data, voxel_size
                )

            # Compute segment length
            if points.shape[0] >= 2:
                # Scale voxel coords to mm
                points_mm = points * np.array(voxel_size)
                diffs = np.diff(points_mm, axis=0)
                segment_length = float(np.sum(np.linalg.norm(diffs, axis=1)))
            else:
                segment_length = 0.0

            centerline_data[artery_name] = {
                "centerline_points": points,
                "radii": radii,
                "segment_length_mm": segment_length,
            }
            logger.info(
                f"  {artery_name}: {points.shape[0]} centerline points, "
                f"length={segment_length:.1f}mm"
            )

        except Exception as exc:
            logger.error(f"  Centerline extraction failed for {artery_name}: {exc}")
            centerline_data[artery_name] = {
                "centerline_points": np.array([]).reshape(0, 3),
                "radii": np.array([]),
                "segment_length_mm": 0.0,
            }

    return centerline_data, warnings


def _check_vmtk() -> bool:
    """Check if VMTK is available."""
    try:
        from vmtk import vmtkscripts  # noqa: F401
        logger.info("VMTK is available.")
        return True
    except ImportError:
        logger.info("VMTK not installed.")
        return False


def _vmtk_centerline(
    artery_mask: np.ndarray,
    voxel_size: tuple[float, ...],
) -> tuple[np.ndarray, np.ndarray]:
    """
    Extract centerline using VMTK.

    Converts binary mask to surface, runs vmtkcenterlines,
    extracts points and radii.
    """
    import vtk
    from vtk.util.numpy_support import vtk_to_numpy
    from vmtk import vmtkscripts

    # Convert binary mask to VTK image
    vtk_image = vtk.vtkImageData()
    vtk_image.SetDimensions(artery_mask.shape)
    vtk_image.SetSpacing(voxel_size)

    flat_data = artery_mask.flatten(order="F").astype(np.float64)
    vtk_array = vtk.vtkDoubleArray()
    vtk_array.SetNumberOfTuples(len(flat_data))
    for i, val in enumerate(flat_data):
        vtk_array.SetValue(i, val)
    vtk_image.GetPointData().SetScalars(vtk_array)

    # Marching cubes to get surface
    mc = vtk.vtkMarchingCubes()
    mc.SetInputData(vtk_image)
    mc.SetValue(0, 0.5)
    mc.Update()
    surface = mc.GetOutput()

    if surface.GetNumberOfPoints() < 10:
        raise ValueError("Surface too small for VMTK centerline extraction")

    # Run VMTK centerline extraction
    centerlines = vmtkscripts.vmtkCenterlines()
    centerlines.Surface = surface
    centerlines.Execute()

    # Extract points
    cl_polydata = centerlines.Centerlines
    points_vtk = cl_polydata.GetPoints()
    n_points = points_vtk.GetNumberOfPoints()

    points = np.array([points_vtk.GetPoint(i) for i in range(n_points)])

    # Convert back to voxel coordinates
    points_voxel = points / np.array(voxel_size)

    # Extract radii (MaximumInscribedSphereRadius)
    radii_array = cl_polydata.GetPointData().GetArray("MaximumInscribedSphereRadius")
    if radii_array is not None:
        radii = vtk_to_numpy(radii_array)
    else:
        # Compute radii from distance transform if VMTK doesn't provide them
        radii = np.ones(n_points)

    return points_voxel, radii


def _skeletonize_centerline(
    artery_mask: np.ndarray,
    full_vessel_mask: np.ndarray,
    voxel_size: tuple[float, ...],
) -> tuple[np.ndarray, np.ndarray]:
    """
    Fallback: extract centerline using skimage skeletonize_3d
    and compute radii from distance transform.

    Args:
        artery_mask: Binary mask of a single artery (3D bool array).
        full_vessel_mask: Full binary vessel mask (for distance transform).
        voxel_size: Voxel dimensions in mm.

    Returns:
        Tuple of (ordered centerline points (N×3), radii (N,)).
    """
    from skimage.morphology import skeletonize_3d

    # Skeletonize the artery mask
    skeleton = skeletonize_3d(artery_mask.astype(np.uint8))
    skeleton_points = np.argwhere(skeleton > 0)

    if skeleton_points.shape[0] == 0:
        return np.array([]).reshape(0, 3), np.array([])

    # Compute distance transform of the full vessel mask for radius estimation
    # The distance transform gives the distance to the nearest background voxel
    dt = ndimage.distance_transform_edt(
        full_vessel_mask > 0,
        sampling=voxel_size,
    )

    # Get radii at skeleton points
    radii = np.array([
        dt[p[0], p[1], p[2]] for p in skeleton_points
    ])

    # Order the skeleton points along the path
    ordered_points = _order_skeleton_points(skeleton_points, voxel_size)

    # Re-extract radii for ordered points
    ordered_radii = np.array([
        dt[p[0], p[1], p[2]] for p in ordered_points
    ])

    return ordered_points, ordered_radii


def _order_skeleton_points(
    points: np.ndarray,
    voxel_size: tuple[float, ...],
) -> np.ndarray:
    """
    Order skeleton points along the vessel path using graph traversal.

    Finds endpoints (points with ≤1 neighbor), then walks through
    the skeleton from one endpoint to the other.
    """
    if points.shape[0] <= 2:
        return points

    # Scale to mm for distance computation
    points_mm = points * np.array(voxel_size)

    # Build adjacency based on 26-connectivity (max distance ~1.73 voxels)
    max_neighbor_dist = np.sqrt(3) * max(voxel_size) * 1.5
    distances = cdist(points_mm, points_mm)

    # Create adjacency matrix
    adjacency = (distances > 0) & (distances < max_neighbor_dist)
    neighbor_counts = adjacency.sum(axis=1)

    # Find endpoints (1 neighbor) or use most distant pair
    endpoints = np.where(neighbor_counts <= 1)[0]
    if len(endpoints) < 1:
        # No clear endpoints — find the two most distant points
        max_idx = np.unravel_index(distances.argmax(), distances.shape)
        start_idx = max_idx[0]
    else:
        start_idx = endpoints[0]

    # Walk along skeleton using greedy nearest-neighbor traversal
    ordered_indices = [start_idx]
    visited = {start_idx}

    current = start_idx
    while len(ordered_indices) < points.shape[0]:
        # Find nearest unvisited neighbor
        neighbors = np.where(adjacency[current])[0]
        unvisited = [n for n in neighbors if n not in visited]

        if not unvisited:
            # No connected unvisited neighbors — find nearest unvisited point
            unvisited_all = [
                i for i in range(points.shape[0]) if i not in visited
            ]
            if not unvisited_all:
                break
            dists = distances[current, unvisited_all]
            nearest = unvisited_all[np.argmin(dists)]
            ordered_indices.append(nearest)
            visited.add(nearest)
            current = nearest
        else:
            # Pick the nearest connected neighbor
            dists = distances[current, unvisited]
            nearest = unvisited[np.argmin(dists)]
            ordered_indices.append(nearest)
            visited.add(nearest)
            current = nearest

    return points[ordered_indices]
