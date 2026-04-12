"""
config.py — Central configuration for all tunable thresholds and paths.

All pipeline thresholds are defined here so they can be adjusted
without modifying pipeline code.
"""

import os
from pathlib import Path
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent.parent
OUTPUT_DIR = Path(os.environ.get("OUTPUT_DIR", str(BASE_DIR / "output")))
TEMP_DIR = Path(os.environ.get("TEMP_DIR", str(BASE_DIR / "temp")))

# Ensure directories exist
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
TEMP_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# API Keys (loaded from environment — NEVER hardcode)
# ---------------------------------------------------------------------------
GEMINI_API_KEY: str = os.environ.get("GEMINI_API_KEY", "")

# ---------------------------------------------------------------------------
# VesselBoost paths
# ---------------------------------------------------------------------------
VESSELBOOST_DIR = Path(os.environ.get(
    "VESSELBOOST_DIR",
    str(BASE_DIR / "external" / "VesselBoost")
))
VESSELBOOST_MODEL_DIR = Path(os.environ.get(
    "VESSELBOOST_MODEL_DIR",
    str(VESSELBOOST_DIR / "saved_models")
))

# ---------------------------------------------------------------------------
# eICAB paths
# ---------------------------------------------------------------------------
EICAB_DIR = Path(os.environ.get(
    "EICAB_DIR",
    str(BASE_DIR / "external" / "eicab")
))

# ---------------------------------------------------------------------------
# Step 1 — Preprocessing
# ---------------------------------------------------------------------------
TARGET_RESOLUTION_MM: float = 0.5  # Isotropic target voxel size in mm

# ---------------------------------------------------------------------------
# Step 5a — Stenosis thresholds (NASCET criteria)
# ---------------------------------------------------------------------------
STENOSIS_MODERATE_THRESHOLD: float = 50.0   # Percent
STENOSIS_SEVERE_THRESHOLD: float = 70.0     # Percent
REFERENCE_SEGMENT_LENGTH_MM: float = 10.0   # mm of proximal centerline for reference radius

# ---------------------------------------------------------------------------
# Step 5b — Aneurysm detection thresholds
# ---------------------------------------------------------------------------
ANEURYSM_SIZE_RATIO: float = 1.6           # local_max_radius / parent_radius
ANEURYSM_ASPECT_RATIO: float = 1.2         # depth / neck_width
ANEURYSM_DEVIATION_STD: float = 2.0        # Standard deviations from tubular model
ANEURYSM_WINDOW_MM: float = 3.0            # Search window around bifurcations in mm

# ---------------------------------------------------------------------------
# Step 5c — Tortuosity thresholds
# ---------------------------------------------------------------------------
TORTUOSITY_DF_CUTOFF: float = 1.5           # Distance Factor flagging threshold
TORTUOSITY_SOAM_PERCENTILE: float = 90.0    # SOAM flagging percentile

# ---------------------------------------------------------------------------
# Step 5d — Small Vessel Disease thresholds
# ---------------------------------------------------------------------------
SVD_RATIO_CUTOFF: float = 0.4              # deep_WM_density / cortical_density
SVD_SMALL_VESSEL_RADIUS_MM: float = 0.75   # Max radius to classify as "small vessel"

# ---------------------------------------------------------------------------
# Step 8 — Risk score thresholds
# ---------------------------------------------------------------------------
RISK_LOW_THRESHOLD: float = 30.0       # Score below this = "low"
RISK_MODERATE_THRESHOLD: float = 60.0  # Score below this = "moderate", above = "high"

# Risk score weights — Large-vessel ischemic stroke
RISK_STENOSIS_WEIGHT: float = 0.5
RISK_TORTUOSITY_WEIGHT: float = 0.2
RISK_ANEURYSM_WEIGHT: float = 0.3

# ---------------------------------------------------------------------------
# MNI152 Atlas ROI approximate MNI coordinate ranges (mm)
# Used for fallback artery labeling and SVD ROI definition
# ---------------------------------------------------------------------------
MNI_ROI_DEEP_WM = {
    "x_range": (-25, 25),
    "y_range": (-20, 30),
    "z_range": (25, 45),
}
MNI_ROI_BASAL_GANGLIA = {
    "x_range": (-30, 30),
    "y_range": (-10, 15),
    "z_range": (-5, 15),
}
MNI_ROI_CORTICAL_GM = {
    "x_range": (-70, 70),
    "y_range": (-100, 65),
    "z_range": (-40, 75),
}

# ---------------------------------------------------------------------------
# Artery names used throughout the pipeline
# ---------------------------------------------------------------------------
ARTERY_NAMES: list[str] = [
    "left_ICA",
    "right_ICA",
    "left_MCA",
    "right_MCA",
    "left_ACA",
    "right_ACA",
    "left_PCA",
    "right_PCA",
    "basilar",
    "left_vertebral",
    "right_vertebral",
]

# eICAB label-to-name mapping.
# Upstream eICAB emits the Circle of Willis labels below. We collapse the
# left/right PCA branches (P1/P2) into a single left/right PCA artery name
# for the rest of this pipeline. Vertebrals are not part of upstream eICAB;
# synthetic labels 101/102 are reserved for the atlas-based fallback.
EICAB_LABEL_MAP: dict[int, str] = {
    1: "left_ICA",
    2: "right_ICA",
    3: "basilar",
    5: "left_ACA",
    6: "right_ACA",
    7: "left_MCA",
    8: "right_MCA",
    11: "left_PCA",
    12: "right_PCA",
    13: "left_PCA",
    14: "right_PCA",
    101: "left_vertebral",
    102: "right_vertebral",
}

# Posterior circulation arteries (higher weight in aneurysm rupture risk)
POSTERIOR_CIRCULATION: set[str] = {
    "left_PCA", "right_PCA", "basilar", "left_vertebral", "right_vertebral"
}

# ---------------------------------------------------------------------------
# Gemini model configuration
# ---------------------------------------------------------------------------
GEMINI_MODEL: str = "gemini-1.5-pro-latest"
GEMINI_SYSTEM_PROMPT: str = (
    "You are a neuroradiology analysis assistant. You will receive MRI vessel "
    "overlay images and structured feature data extracted from a cerebrovascular "
    "segmentation pipeline. Based on this input, produce: (1) a structured JSON "
    "report with per-artery findings, severity labels, and risk scores, and "
    "(2) a plain English clinical narrative summary. Be explicit that this is a "
    "research tool and not a clinical diagnosis."
)
