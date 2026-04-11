"""
step7_gemini.py — Gemini 1.5 Pro Vision report generation.

Pipeline Step 7:
    Send rendered PNG slices and full feature JSON to Gemini 1.5 Pro Vision.
    Parse the response to extract:
        (1) Structured JSON report with per-artery findings
        (2) Plain English clinical narrative summary
"""

import json
import logging
import re
from pathlib import Path
from typing import Any

from app.config import GEMINI_API_KEY, GEMINI_MODEL, GEMINI_SYSTEM_PROMPT
from app.models import GeminiReport, SliceImages

logger = logging.getLogger(__name__)


def generate_gemini_report(
    slice_paths: dict[str, SliceImages],
    features_json: dict[str, Any],
) -> tuple[GeminiReport, list[str]]:
    """
    Generate a clinical analysis report using Gemini 1.5 Pro Vision.

    Args:
        slice_paths: Dict mapping artery name → SliceImages with PNG paths.
        features_json: Full feature extraction results as JSON-serializable dict.

    Returns:
        Tuple of (GeminiReport, list of warnings).
    """
    warnings: list[str] = []

    if not GEMINI_API_KEY:
        msg = "GEMINI_API_KEY not set. Skipping Gemini report generation."
        logger.warning(msg)
        warnings.append(msg)
        return GeminiReport(
            structured_json={},
            narrative_summary="Gemini report not generated: API key not configured.",
        ), warnings

    try:
        import google.generativeai as genai

        # Configure the API
        genai.configure(api_key=GEMINI_API_KEY)
        model = genai.GenerativeModel(GEMINI_MODEL)

        # Build the prompt content
        content_parts = []

        # Add system prompt context
        content_parts.append(GEMINI_SYSTEM_PROMPT)
        content_parts.append("\n\n--- FEATURE DATA ---\n")
        content_parts.append(json.dumps(features_json, indent=2, default=str))

        # Add images
        image_count = 0
        for artery_name, images in slice_paths.items():
            for view_name, img_path in [
                ("axial", images.axial),
                ("coronal", images.coronal),
            ]:
                if img_path and Path(img_path).exists():
                    try:
                        img_data = _load_image_for_gemini(img_path)
                        content_parts.append(img_data)
                        content_parts.append(
                            f"\n[Image: {artery_name} — {view_name} view]\n"
                        )
                        image_count += 1
                    except Exception as exc:
                        logger.warning(
                            f"Failed to load image {img_path}: {exc}"
                        )

        logger.info(
            f"Sending {image_count} images and feature data to Gemini..."
        )

        # Add instruction for response format
        content_parts.append(
            "\n\n--- INSTRUCTIONS ---\n"
            "Based on the feature data and images above, produce your response "
            "in the following format:\n\n"
            "STRUCTURED_JSON_START\n"
            "{your structured JSON report here}\n"
            "STRUCTURED_JSON_END\n\n"
            "NARRATIVE_START\n"
            "{your plain English clinical narrative summary here}\n"
            "NARRATIVE_END\n"
        )

        # Send to Gemini
        response = model.generate_content(content_parts)

        # Parse response
        response_text = response.text
        logger.info(f"Gemini response received ({len(response_text)} chars).")

        structured_json = _extract_json_block(response_text)
        narrative = _extract_narrative(response_text)

        return GeminiReport(
            structured_json=structured_json,
            narrative_summary=narrative,
        ), warnings

    except ImportError:
        msg = (
            "google-generativeai package not installed. "
            "Install with: pip install google-generativeai"
        )
        logger.warning(msg)
        warnings.append(msg)
        return GeminiReport(
            structured_json={},
            narrative_summary=f"Gemini report not generated: {msg}",
        ), warnings

    except Exception as exc:
        msg = f"Gemini API call failed: {exc}"
        logger.error(msg)
        warnings.append(msg)
        return GeminiReport(
            structured_json={},
            narrative_summary=f"Gemini report generation failed: {exc}",
        ), warnings


def _load_image_for_gemini(image_path: str) -> Any:
    """
    Load an image file and prepare it for the Gemini API.

    Returns a PIL Image or the appropriate format for the google-generativeai SDK.
    """
    from PIL import Image
    img = Image.open(image_path)
    return img


def _extract_json_block(response_text: str) -> dict:
    """
    Extract the structured JSON block from Gemini's response.

    Looks for content between STRUCTURED_JSON_START and STRUCTURED_JSON_END
    markers, or falls back to finding any JSON block in the response.
    """
    # Try explicit markers first
    json_match = re.search(
        r"STRUCTURED_JSON_START\s*(.*?)\s*STRUCTURED_JSON_END",
        response_text,
        re.DOTALL,
    )

    if json_match:
        json_str = json_match.group(1).strip()
    else:
        # Fallback: find the largest JSON block in the response
        json_blocks = re.findall(
            r"```json\s*(.*?)\s*```",
            response_text,
            re.DOTALL,
        )
        if json_blocks:
            json_str = max(json_blocks, key=len)
        else:
            # Try to find any {...} block
            brace_match = re.search(r"\{.*\}", response_text, re.DOTALL)
            if brace_match:
                json_str = brace_match.group(0)
            else:
                logger.warning("Could not extract JSON from Gemini response.")
                return {"raw_response": response_text}

    try:
        return json.loads(json_str)
    except json.JSONDecodeError as exc:
        logger.warning(f"Failed to parse Gemini JSON: {exc}")
        return {"raw_response": json_str}


def _extract_narrative(response_text: str) -> str:
    """
    Extract the narrative text block from Gemini's response.

    Looks for content between NARRATIVE_START and NARRATIVE_END markers,
    or returns the full response as fallback.
    """
    narrative_match = re.search(
        r"NARRATIVE_START\s*(.*?)\s*NARRATIVE_END",
        response_text,
        re.DOTALL,
    )

    if narrative_match:
        return narrative_match.group(1).strip()

    # Fallback: return everything after the JSON block
    json_end = response_text.find("STRUCTURED_JSON_END")
    if json_end > 0:
        return response_text[json_end + len("STRUCTURED_JSON_END"):].strip()

    # Just return the full text if no markers found
    # Try to remove JSON blocks
    cleaned = re.sub(r"```json.*?```", "", response_text, flags=re.DOTALL)
    cleaned = re.sub(r"STRUCTURED_JSON_START.*?STRUCTURED_JSON_END", "", cleaned, flags=re.DOTALL)
    return cleaned.strip() if cleaned.strip() else response_text
