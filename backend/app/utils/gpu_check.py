"""
gpu_check.py — Detect GPU availability and log warnings.

Used throughout the pipeline to decide whether to use GPU-accelerated
tools or gracefully fall back to CPU-only mode.
"""

import logging
import platform

logger = logging.getLogger(__name__)


def _detect_torch_device() -> tuple[bool, str, str]:
    """
    Detect the best available PyTorch compute backend.

    Returns:
        Tuple of:
            - whether hardware acceleration is available
            - device string ('cuda', 'mps', or 'cpu')
            - human-readable description for logging
    """
    import torch

    system = platform.system()
    if system == "Darwin":
        mps_backend = getattr(torch.backends, "mps", None)
        if mps_backend and mps_backend.is_available():
            machine = platform.machine()
            return True, "mps", f"Apple Metal Performance Shaders ({system} {machine})"
    else:
        if torch.cuda.is_available():
            device_name = torch.cuda.get_device_name(0)
            vram = torch.cuda.get_device_properties(0).total_memory / (1024 ** 3)
            return True, "cuda", f"{device_name} ({vram:.1f} GB VRAM)"

    return False, "cpu", "CPU only"


def check_gpu() -> bool:
    """
    Check if a hardware-accelerated PyTorch backend is available.

    Returns:
        True if CUDA or Apple MPS is available, False otherwise.
    """
    try:
        available, device, description = _detect_torch_device()
        if available:
            logger.info("Accelerated compute detected: %s via %s", description, device)
        else:
            if platform.system() == "Darwin":
                logger.warning(
                    "No Apple MPS accelerator detected. Pipeline will run on CPU. "
                    "On macOS, this usually means PyTorch was built without MPS support or "
                    "the machine does not have Apple Silicon."
                )
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
    """Return 'cuda', 'mps', or 'cpu' based on the available backend."""
    try:
        _, device, _ = _detect_torch_device()
        return device
    except Exception:
        return "cpu"
