"""
main.py — FastAPI application for cerebrovascular arterial analysis.

Provides three endpoints:
    GET  /health             — Service health check
    POST /analyze            — Upload NIfTI, start analysis, return job ID
    GET  /results/{job_id}   — Retrieve analysis results or status
"""

import asyncio
import json
import logging
import shutil
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import OUTPUT_DIR, TEMP_DIR
from app.utils.gpu_check import check_gpu

# ---------------------------------------------------------------------------
# Logging configuration
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("cerebrovascular")

# ---------------------------------------------------------------------------
# In-memory job store
# ---------------------------------------------------------------------------
# Maps job_id → {"status": "processing"|"complete"|"failed", "result": dict|None}
_jobs: dict[str, dict] = {}


# ---------------------------------------------------------------------------
# Application lifespan
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events."""
    # Startup
    logger.info("=" * 60)
    logger.info("Cerebrovascular Arterial Analysis Backend — Starting")
    logger.info("=" * 60)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    gpu = check_gpu()
    logger.info(f"GPU available: {gpu}")
    logger.info(f"Output directory: {OUTPUT_DIR}")
    logger.info(f"Temp directory:   {TEMP_DIR}")
    logger.info("Ready to accept requests.")
    yield
    # Shutdown
    logger.info("Shutting down.")


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(
    title="Cerebrovascular Arterial Analysis API",
    description=(
        "REST API for automated cerebrovascular arterial blood vessel analysis. "
        "Accepts raw NIfTI TOF-MRA files and returns structured findings "
        "including stenosis, aneurysm candidates, tortuosity metrics, "
        "small vessel disease proxy, risk scores, and an AI-generated report."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

# ---------------------------------------------------------------------------
# CORS & Static Files
# ---------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # For hacking ease, allow all origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/output", StaticFiles(directory=str(OUTPUT_DIR)), name="output")


# ---------------------------------------------------------------------------
# GET /health
# ---------------------------------------------------------------------------
@app.get("/health", tags=["Status"])
async def health_check():
    """
    Service health check.

    Returns the service status and GPU availability.
    """
    gpu_available = check_gpu()
    return {
        "status": "healthy",
        "gpu_available": gpu_available,
    }


# ---------------------------------------------------------------------------
# POST /analyze
# ---------------------------------------------------------------------------
@app.post("/analyze", tags=["Analysis"])
async def analyze(file: UploadFile = File(...)):
    """
    Upload a NIfTI TOF-MRA file and start the analysis pipeline.

    Accepts .nii or .nii.gz files via multipart upload.
    Returns a job_id that can be used to poll for results.
    """
    # Validate file extension
    filename = file.filename or "upload.nii.gz"
    if not (filename.endswith(".nii") or filename.endswith(".nii.gz")):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Invalid file format: '{filename}'. "
                "Only .nii and .nii.gz files are accepted."
            ),
        )

    # Generate job ID
    job_id = str(uuid.uuid4())
    logger.info(f"New analysis job: {job_id} — File: {filename}")

    # Save uploaded file to temp directory
    temp_path = TEMP_DIR / f"{job_id}_{filename}"
    try:
        with open(temp_path, "wb") as f:
            content = await file.read()
            f.write(content)
        logger.info(f"Uploaded file saved: {temp_path} ({len(content):,} bytes)")
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to save uploaded file: {exc}",
        )

    # Initialize job status
    _jobs[job_id] = {
        "status": "processing",
        "result": None,
        "progress": {"step": 0, "total": 8, "action": "Starting..."},
    }

    # Launch pipeline in background
    asyncio.create_task(_run_pipeline_async(job_id, str(temp_path)))

    return JSONResponse(
        status_code=202,
        content={
            "job_id": job_id,
            "status": "processing",
            "message": (
                f"Analysis started for '{filename}'. "
                f"Poll GET /results/{job_id} for results."
            ),
        },
    )


# ---------------------------------------------------------------------------
# POST /analyze/demo
# ---------------------------------------------------------------------------
@app.post("/analyze/demo", tags=["Analysis"])
async def analyze_demo():
    """
    Start the analysis pipeline on the preloaded dataset/1.nii file.
    If a cached result exists, simulates a 10-second progressive pipeline
    so the progress bar animates through all 8 steps.
    """
    demo_path = (Path(__file__).parent.parent.parent / "dataset" / "1.nii").resolve()
    if not demo_path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"Demo dataset not found at {demo_path}",
        )
        
    job_id = "demo-job"
    logger.info(f"Demo analysis requested. checking for cache...")
    
    # Check for cached result
    cache_path = OUTPUT_DIR / job_id / "result.json"
    if cache_path.exists():
        try:
            with open(cache_path, "r") as f:
                cached_result = json.load(f)
            
            # Initialize job as processing so the frontend sees progress
            _jobs[job_id] = {
                "status": "processing",
                "result": None,
                "progress": {"step": 0, "total": 8, "action": "Starting..."},
            }
            
            # Launch simulated progressive pipeline in background
            asyncio.create_task(_simulate_demo_progress(job_id, cached_result))
            
            logger.info("Demo started — simulating 10s progressive pipeline from cache.")
            return JSONResponse(
                status_code=202,
                content={
                    "job_id": job_id,
                    "status": "processing",
                    "message": "Demo analysis started. Poll GET /results/demo-job for results.",
                },
            )
        except Exception as exc:
            logger.warning(f"Failed to load demo cache: {exc}. Falling back to recalculation.")

    # FALLBACK: Normal pipeline if no cache
    logger.info(f"New demo analysis job (recalculating): {job_id}")

    # Initialize job status
    _jobs[job_id] = {
        "status": "processing",
        "result": None,
        "progress": {"step": 0, "total": 8, "action": "Starting..."},
    }

    # Launch pipeline in background
    asyncio.create_task(_run_pipeline_async(job_id, str(demo_path), is_demo=True))

    return JSONResponse(
        status_code=202,
        content={
            "job_id": job_id,
            "status": "processing",
            "message": "Demo analysis started. Poll GET /results/{job_id} for results.",
        },
    )


# ---------------------------------------------------------------------------
# GET /demo-nifti — serve the raw demo NIfTI so the viewer can load it immediately
# ---------------------------------------------------------------------------
@app.get("/demo-nifti", tags=["Analysis"])
async def get_demo_nifti():
    """Return the raw demo 1.nii file for immediate viewer loading."""
    demo_path = (Path(__file__).parent.parent.parent / "dataset" / "1.nii").resolve()
    if not demo_path.exists():
        raise HTTPException(status_code=404, detail="Demo dataset not found.")
    return FileResponse(str(demo_path), media_type="application/octet-stream", filename="1.nii")


# ---------------------------------------------------------------------------
# GET /results/{job_id}
# ---------------------------------------------------------------------------
@app.get("/results/{job_id}", tags=["Analysis"])
async def get_results(job_id: str):
    """
    Retrieve analysis results for a given job.

    Returns the full JSON result when processing is complete,
    or a status string if still processing or failed.
    """
    if job_id not in _jobs:
        raise HTTPException(
            status_code=404,
            detail=f"Job '{job_id}' not found.",
        )

    job = _jobs[job_id]

    if job["status"] == "processing":
        return JSONResponse(
            status_code=200,
            content={
                "job_id": job_id,
                "status": "processing",
                "progress": job.get("progress", {"step": 0, "total": 8, "action": "Starting..."}),
            },
        )
    elif job["status"] == "failed":
        return JSONResponse(
            status_code=200,
            content={
                "job_id": job_id,
                "status": "failed",
                "message": job.get("error", "Pipeline failed with unknown error."),
            },
        )
    else:
        # Complete
        return JSONResponse(
            status_code=200,
            content=job["result"],
        )


# ---------------------------------------------------------------------------
# GET /render/{job_id} — return overlay URL for the vessel mask
# ---------------------------------------------------------------------------
@app.get("/render/{job_id}", tags=["Analysis"])
async def get_render(job_id: str):
    """
    Return the overlay URL for the vessel mask NIfTI so the viewer
    can display the segmentation as a colored overlay.
    """
    job_dir = OUTPUT_DIR / job_id
    if not job_dir.exists():
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")

    # Find the vessel mask file in the output directory
    mask_files = list(job_dir.glob("*vessel_mask*"))
    if not mask_files:
        raise HTTPException(status_code=404, detail="No vessel mask found for this job.")

    mask_filename = mask_files[0].name
    return {"overlay_url": f"/output/{job_id}/{mask_filename}"}


# ---------------------------------------------------------------------------
# Simulated demo progress (10 seconds, 8 steps)
# ---------------------------------------------------------------------------
async def _simulate_demo_progress(job_id: str, cached_result: dict):
    """Simulate progressive pipeline steps over ~10 seconds, then mark complete."""
    STEP_LABELS = [
        "Preprocessing",
        "Vessel Segmentation",
        "Artery Labeling",
        "Centerline Extraction",
        "Feature Analysis",
        "Slice Rendering",
        "AI Report",
        "Risk Scoring",
    ]
    TOTAL_DURATION = 10.0  # seconds
    STEP_COUNT = len(STEP_LABELS)
    STEP_DURATION = TOTAL_DURATION / STEP_COUNT  # ~1.25s per step

    for i, label in enumerate(STEP_LABELS, start=1):
        _jobs[job_id]["progress"] = {"step": i, "total": STEP_COUNT, "action": label}
        logger.info(f"[{job_id}] Simulated progress {i}/{STEP_COUNT}: {label}")
        await asyncio.sleep(STEP_DURATION)

    # Mark complete with the cached result
    _jobs[job_id] = {
        "status": "complete",
        "result": cached_result,
        "progress": {"step": 8, "total": 8, "action": "Analysis complete!"},
    }
    logger.info(f"[{job_id}] Demo simulation complete.")


# ---------------------------------------------------------------------------
# Background pipeline runner
# ---------------------------------------------------------------------------
async def _run_pipeline_async(job_id: str, input_path: str, is_demo: bool = False):
    """Run the pipeline in a background thread."""
    def _progress(step: int, action: str):
        if job_id in _jobs:
            _jobs[job_id]["progress"] = {"step": step, "total": 8, "action": action}
        logger.info(f"[{job_id}] Progress {step}/8: {action}")

    try:
        from app.pipeline.orchestrator import run_pipeline
        result = await asyncio.to_thread(run_pipeline, job_id, input_path, _progress)
        _jobs[job_id] = {
            "status": "complete",
            "result": result,
        }
        logger.info(f"Job {job_id} completed successfully.")
    except Exception as exc:
        logger.error(f"Job {job_id} failed: {exc}", exc_info=True)
        _jobs[job_id] = {
            "status": "failed",
            "result": None,
            "error": str(exc),
        }
    finally:
        # Clean up temp file (skip if it's the permanent demo dataset)
        if not is_demo:
            temp_path = Path(input_path)
            if temp_path.exists():
                try:
                    temp_path.unlink()
                    logger.info(f"Cleaned up temp file: {temp_path}")
                except Exception:
                    pass
