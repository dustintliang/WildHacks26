"""
step8_risk.py — Rule-based risk score computation.

Pipeline Step 8:
    Compute percentage risk estimates for:
        - Large-vessel ischemic stroke
        - Lacunar / small vessel stroke
        - Aneurysm rupture
    Using extracted geometric features with configurable weights.
"""

import logging
from typing import Optional

import numpy as np

from app.config import (
    ANEURYSM_SIZE_RATIO,
    POSTERIOR_CIRCULATION,
    RISK_ANEURYSM_WEIGHT,
    RISK_LOW_THRESHOLD,
    RISK_MODERATE_THRESHOLD,
    RISK_STENOSIS_WEIGHT,
    RISK_TORTUOSITY_WEIGHT,
    STENOSIS_MODERATE_THRESHOLD,
    STENOSIS_SEVERE_THRESHOLD,
    SVD_RATIO_CUTOFF,
    TORTUOSITY_DF_CUTOFF,
)
from app.models import (
    AneurysmCandidate,
    RiskScore,
    SVDResult,
    StenosisCandidate,
    TortuosityResult,
)

logger = logging.getLogger(__name__)


def compute_risk_scores(
    stenosis_results: dict[str, list[StenosisCandidate]],
    aneurysm_results: dict[str, list[AneurysmCandidate]],
    tortuosity_results: dict[str, TortuosityResult],
    svd_result: Optional[SVDResult],
    patient_age: Optional[int] = None,
) -> dict[str, RiskScore]:
    """
    Compute rule-based risk scores for cerebrovascular conditions.

    Args:
        stenosis_results: Per-artery stenosis candidates.
        aneurysm_results: Per-artery aneurysm candidates.
        tortuosity_results: Per-artery tortuosity metrics.
        svd_result: Small vessel disease proxy result.
        patient_age: Patient age in years (optional, default 60 for PHASES).

    Returns:
        Dict with keys 'large_vessel_stroke', 'lacunar_stroke', 'aneurysm_rupture',
        each mapping to a RiskScore.
    """
    if patient_age is None:
        patient_age = 60  # Default placeholder

    large_vessel = _compute_large_vessel_risk(
        stenosis_results, tortuosity_results, aneurysm_results
    )
    lacunar = _compute_lacunar_risk(svd_result)
    aneurysm = _compute_aneurysm_rupture_risk(
        aneurysm_results, patient_age
    )

    return {
        "large_vessel_stroke": large_vessel,
        "lacunar_stroke": lacunar,
        "aneurysm_rupture": aneurysm,
    }


def _compute_large_vessel_risk(
    stenosis_results: dict[str, list[StenosisCandidate]],
    tortuosity_results: dict[str, TortuosityResult],
    aneurysm_results: dict[str, list[AneurysmCandidate]],
) -> RiskScore:
    """
    Large-vessel ischemic stroke risk.

    Weighted combination:
        0.5 × stenosis_severity + 0.2 × tortuosity + 0.3 × aneurysm_presence
    """
    drivers: list[str] = []

    # --- Stenosis component (0–100) ---
    max_stenosis = 0.0
    max_stenosis_artery = ""
    for artery, candidates in stenosis_results.items():
        for c in candidates:
            if c.stenosis_percent > max_stenosis:
                max_stenosis = c.stenosis_percent
                max_stenosis_artery = artery

    stenosis_score = min(max_stenosis, 100.0)
    if stenosis_score > 0:
        drivers.append(
            f"Stenosis: {stenosis_score:.1f}% in {max_stenosis_artery}"
        )

    # --- Tortuosity component (0–100) ---
    max_df = 1.0
    max_df_artery = ""
    for artery, t in tortuosity_results.items():
        if t.distance_factor > max_df:
            max_df = t.distance_factor
            max_df_artery = artery

    # Normalize DF to 0–100: DF=1.0→0, DF≥3.0→100
    tortuosity_score = min(
        max((max_df - 1.0) / (3.0 - 1.0) * 100.0, 0.0),
        100.0
    )
    if max_df > TORTUOSITY_DF_CUTOFF:
        drivers.append(f"Tortuosity: DF={max_df:.2f} in {max_df_artery}")

    # --- Aneurysm component (0–100) ---
    has_aneurysm = False
    max_confidence = "none"
    aneurysm_artery = ""
    for artery, candidates in aneurysm_results.items():
        for c in candidates:
            has_aneurysm = True
            if (max_confidence == "none" or
                    _confidence_rank(c.confidence) > _confidence_rank(max_confidence)):
                max_confidence = c.confidence
                aneurysm_artery = artery

    aneurysm_score = {
        "none": 0.0,
        "low": 30.0,
        "moderate": 60.0,
        "high": 90.0,
    }.get(max_confidence, 0.0)

    if has_aneurysm:
        drivers.append(
            f"Aneurysm candidate: {max_confidence} confidence in {aneurysm_artery}"
        )

    # --- Weighted combination ---
    total_score = (
        RISK_STENOSIS_WEIGHT * stenosis_score +
        RISK_TORTUOSITY_WEIGHT * tortuosity_score +
        RISK_ANEURYSM_WEIGHT * aneurysm_score
    )
    total_score = min(max(total_score, 0.0), 100.0)

    severity = _score_to_severity(total_score)

    logger.info(
        f"Large-vessel stroke risk: {total_score:.1f} ({severity}) — "
        f"stenosis={stenosis_score:.1f}, tortuosity={tortuosity_score:.1f}, "
        f"aneurysm={aneurysm_score:.1f}"
    )

    return RiskScore(
        score=round(total_score, 1),
        severity=severity,
        drivers=drivers,
    )


def _compute_lacunar_risk(
    svd_result: Optional[SVDResult],
) -> RiskScore:
    """
    Lacunar / small vessel stroke risk.

    Based on:
        - SVD ratio (deep WM density / cortical density)
        - Small vessel count in deep WM
        - Basal ganglia vessel density
    """
    drivers: list[str] = []

    if svd_result is None:
        return RiskScore(
            score=0.0,
            severity="low",
            drivers=["SVD analysis not available"],
        )

    # --- SVD ratio component ---
    # Lower ratio → higher risk. Ratio < 0.4 is flagged.
    # Normalize: ratio=1.0→0, ratio=0.0→100
    ratio_score = max((1.0 - svd_result.svd_ratio) * 100.0, 0.0)
    ratio_score = min(ratio_score, 100.0)

    if svd_result.svd_flag:
        drivers.append(
            f"SVD ratio: {svd_result.svd_ratio:.3f} (below {SVD_RATIO_CUTOFF} threshold)"
        )

    # --- Small vessel count component ---
    # More small vessels in deep WM → higher risk
    # Normalize: 0 vessels→0, ≥100 vessels→100
    vessel_score = min(svd_result.small_vessel_count / 100.0 * 100.0, 100.0)
    if svd_result.small_vessel_count > 0:
        drivers.append(
            f"Small vessel count in deep WM: {svd_result.small_vessel_count}"
        )

    # --- Basal ganglia density component ---
    # Higher BG density might indicate collateral formation (mixed signal)
    bg_score = min(svd_result.basal_ganglia_density * 1000, 100.0)  # Scale up

    # --- Weighted combination ---
    # SVD ratio is the strongest predictor
    total_score = 0.5 * ratio_score + 0.3 * vessel_score + 0.2 * bg_score
    total_score = min(max(total_score, 0.0), 100.0)

    severity = _score_to_severity(total_score)

    logger.info(
        f"Lacunar stroke risk: {total_score:.1f} ({severity})"
    )

    return RiskScore(
        score=round(total_score, 1),
        severity=severity,
        drivers=drivers,
    )


def _compute_aneurysm_rupture_risk(
    aneurysm_results: dict[str, list[AneurysmCandidate]],
    patient_age: int,
) -> RiskScore:
    """
    Aneurysm rupture risk based on PHASES score criteria.

    PHASES components:
        P — Population (not available, assume 0)
        H — Hypertension (not available, assume 0)
        A — Age (using patient_age)
        S — Size of aneurysm (size_ratio)
        E — Earlier SAH (not available, assume 0)
        S — Site (posterior circulation → higher risk)

    We adapt using available geometric features:
        - Size ratio
        - Aspect ratio
        - Location (posterior > anterior)
        - Patient age
    """
    drivers: list[str] = []

    # Collect all aneurysm candidates
    all_candidates: list[tuple[str, AneurysmCandidate]] = []
    for artery, candidates in aneurysm_results.items():
        for c in candidates:
            all_candidates.append((artery, c))

    if not all_candidates:
        return RiskScore(
            score=0.0,
            severity="low",
            drivers=["No aneurysm candidates detected"],
        )

    # Find the highest-risk candidate
    max_risk = 0.0
    for artery, candidate in all_candidates:
        risk = 0.0

        # Size component (0–40 points)
        size_risk = min(
            (candidate.size_ratio - 1.0) / (3.0 - 1.0) * 40.0, 40.0
        )
        size_risk = max(size_risk, 0.0)
        risk += size_risk

        # Aspect ratio component (0–20 points)
        aspect_risk = min(
            (candidate.aspect_ratio - 0.5) / (2.5 - 0.5) * 20.0, 20.0
        )
        aspect_risk = max(aspect_risk, 0.0)
        risk += aspect_risk

        # Location component (0–20 points)
        if artery in POSTERIOR_CIRCULATION:
            risk += 20.0
            drivers.append(f"Posterior circulation location: {artery}")
        else:
            risk += 5.0

        # Age component (0–20 points)
        # Higher risk for age > 70
        age_risk = min(max((patient_age - 40) / (80 - 40) * 20.0, 0.0), 20.0)
        risk += age_risk

        if risk > max_risk:
            max_risk = risk
            drivers = [
                f"Size ratio: {candidate.size_ratio:.2f} in {artery}",
                f"Aspect ratio: {candidate.aspect_ratio:.2f}",
                f"Confidence: {candidate.confidence}",
                f"Patient age: {patient_age}",
            ]
            if artery in POSTERIOR_CIRCULATION:
                drivers.append(f"Posterior circulation location: {artery}")

    total_score = min(max(max_risk, 0.0), 100.0)
    severity = _score_to_severity(total_score)

    logger.info(
        f"Aneurysm rupture risk: {total_score:.1f} ({severity})"
    )

    return RiskScore(
        score=round(total_score, 1),
        severity=severity,
        drivers=drivers,
    )


def _score_to_severity(score: float) -> str:
    """Convert a 0–100 risk score to a severity label."""
    if score < RISK_LOW_THRESHOLD:
        return "low"
    elif score < RISK_MODERATE_THRESHOLD:
        return "moderate"
    else:
        return "high"


def _confidence_rank(confidence: str) -> int:
    """Rank confidence levels for comparison."""
    return {"none": 0, "low": 1, "moderate": 2, "high": 3}.get(confidence, 0)
