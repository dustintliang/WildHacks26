# =============================================================================
# Cerebrovascular Arterial Analysis Backend — Dockerfile
# =============================================================================
# Multi-stage build:
#   Stage 1: Install system dependencies and external tools
#   Stage 2: Install Python dependencies and application code
#
# Supports GPU (NVIDIA CUDA) with graceful CPU fallback.
# =============================================================================

# Use NVIDIA CUDA base for GPU support; falls back to CPU if no GPU detected
FROM nvidia/cuda:12.1.0-runtime-ubuntu22.04 AS base

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

# ---------------------------------------------------------------------------
# System dependencies
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.10 \
    python3.10-venv \
    python3-pip \
    git \
    wget \
    curl \
    unzip \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Make python3.10 the default python
RUN update-alternatives --install /usr/bin/python python /usr/bin/python3.10 1 && \
    update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.10 1

# Upgrade pip
RUN python -m pip install --upgrade pip setuptools wheel

# ---------------------------------------------------------------------------
# Create application directory
# ---------------------------------------------------------------------------
WORKDIR /app

# ---------------------------------------------------------------------------
# Install Python dependencies first (Docker layer caching)
# ---------------------------------------------------------------------------
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ---------------------------------------------------------------------------
# Install HD-BET for skull stripping
# ---------------------------------------------------------------------------
RUN pip install --no-cache-dir hd-bet || echo "HD-BET installation failed; will use fallback."

# ---------------------------------------------------------------------------
# Clone VesselBoost for vessel segmentation
# ---------------------------------------------------------------------------
RUN git clone --depth 1 https://github.com/KMarshallX/VesselBoost.git /app/external/VesselBoost || \
    echo "VesselBoost clone failed; will use fallback segmentation."

# Install VesselBoost dependencies if clone succeeded
RUN if [ -f /app/external/VesselBoost/requirements.txt ]; then \
        pip install --no-cache-dir -r /app/external/VesselBoost/requirements.txt || true; \
    fi

# ---------------------------------------------------------------------------
# Clone eICAB for Circle of Willis labeling
# ---------------------------------------------------------------------------
RUN git clone --depth 1 https://gitlab.com/felixdumais1/eicab.git /app/external/eicab || \
    echo "eICAB clone failed; will use atlas-based fallback labeling."

# Install eICAB dependencies if clone succeeded
RUN if [ -f /app/external/eicab/requirements.txt ]; then \
        pip install --no-cache-dir -r /app/external/eicab/requirements.txt || true; \
    fi

# ---------------------------------------------------------------------------
# Install VMTK (optional — install via conda if available)
# ---------------------------------------------------------------------------
# VMTK requires conda and has complex dependencies. For the Docker image,
# we attempt installation but the pipeline gracefully falls back to
# skimage.morphology.skeletonize_3d if VMTK is unavailable.
RUN pip install --no-cache-dir vmtk 2>/dev/null || \
    echo "VMTK pip install failed (expected); will use skeletonize fallback."

# ---------------------------------------------------------------------------
# Copy application code
# ---------------------------------------------------------------------------
COPY app/ /app/app/
COPY .env.example /app/.env.example

# ---------------------------------------------------------------------------
# Create output and temp directories
# ---------------------------------------------------------------------------
RUN mkdir -p /app/output /app/temp

# ---------------------------------------------------------------------------
# Environment variables
# ---------------------------------------------------------------------------
ENV VESSELBOOST_DIR=/app/external/VesselBoost
ENV EICAB_DIR=/app/external/eicab
ENV OUTPUT_DIR=/app/output
ENV TEMP_DIR=/app/temp
# GEMINI_API_KEY should be passed at runtime via -e or --env-file

# ---------------------------------------------------------------------------
# Expose port and set entrypoint
# ---------------------------------------------------------------------------
EXPOSE 8000

ENTRYPOINT ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
