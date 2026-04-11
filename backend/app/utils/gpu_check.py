"""
gpu_check.py — Detect GPU availability and log warnings.

Used throughout the pipeline to decide whether to use GPU-accelerated
tools or gracefully fall back to CPU-only mode.
"""

import logging

logger = logging.getLogger(__name__)


def check_gpu() -> bool:
    """
    Check if a CUDA-capable GPU is available via PyTorch.

    Returns:
        True if GPU is available, False otherwise.
    """
    try:
        import torch
        available = torch.cuda.is_available()
        if available:
            device_name = torch.cuda.get_device_name(0)
            vram = torch.cuda.get_device_properties(0).total_mem / (1024 ** 3)
            logger.info(f"GPU detected: {device_name} ({vram:.1f} GB VRAM)")
        else:
            logger.warning(
                "No CUDA GPU detected. Pipeline will run on CPU. "
                "This may be significantly slower for deep learning steps."
            )
        return available
    except ImportError:
        logger.warning(
            "PyTorch is not installed — cannot check GPU availability. "
            "Pipeline will assume CPU-only mode."
        )
        return False
    except Exception as exc:
        logger.warning(f"GPU check failed with error: {exc}. Assuming CPU-only.")
        return False


def get_device_string() -> str:
    """Return 'cuda' if GPU available, else 'cpu'."""
    return "cuda" if check_gpu() else "cpu"
