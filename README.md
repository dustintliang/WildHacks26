# VascuSense

A Python FastAPI backend for automated cerebrovascular arterial blood vessel analysis from TOF-MRA neuroimaging data. Upload a raw NIfTI file and receive a full structured analysis including vessel segmentation, artery labeling, stenosis/aneurysm/tortuosity detection, small vessel disease metrics, AI-generated clinical narrative, and rule-based risk scores.


## Description

VascuSense is an automated cerebrovascular analysis platform that detects structural abnormalities in brain arteries from TOF-MRA scans (.nii / .nii.gz) using geometric vessel modeling and rule-based risk scoring. The system processes medical imaging data through a multi-stage pipeline including vessel segmentation, artery labeling, centerline extraction, feature analysis, and AI-assisted report generation.

VascuSense evaluates several clinically relevant vascular conditions:

Aneurysm candidates, detected near arterial bifurcations using vessel expansion and shape deviation metrics
Stenosis (arterial narrowing) measured using NASCET percentage-based radius comparisons
Vessel tortuosity, quantified through curvature-based geometric metrics
Small Vessel Disease indicators, estimated using regional vessel density differences

The platform outputs structured per-artery findings, interpretable risk scores (0–100), and a plain-language clinical-style summary to support rapid screening and visualization of potential abnormalities.

Cerebral aneurysms and vascular narrowing are often asymptomatic before serious events such as stroke or hemorrhage. By automating vessel geometry analysis and highlighting suspicious regions, VascuSense helps support early detection workflows in research and educational imaging environments.

Note: VascuSense is a research tool and does not provide clinical diagnosis.

## Getting Started

## Installation


### Prerequisites


- Python 3.10+
- (Optional) NVIDIA GPU with CUDA 12.1+ for accelerated processing
- (Optional) Docker for containerized deployment


### Local Development Setup


1. **Clone the repository:**
  ```bash
  git clone https://github.com/dustintliang/WildHacks26.git
  cd WildHacks26
  ```


2. **Create a virtual environment:**
  ```bash
  python -m venv venv
  source venv/bin/activate  # Linux/Mac
  # or
  .\venv\Scripts\activate   # Windows
  ```


3. **Install Python dependencies:**
  ```bash
  pip install -r requirements.txt
  ```


4. **Set up environment variables:**
  ```bash
  cp .env.example .env
  # Edit .env and add your GEMINI_API_KEY
  ```


5. **Run the server:**
  ```bash
  uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
  ```


### External Tool Setup


#### VesselBoost (Vessel Segmentation)


```bash
# Clone into the external directory
mkdir -p external
git clone https://github.com/KMarshallX/VesselBoost.git external/VesselBoost


# Install dependencies
cd external/VesselBoost
conda env create -f environment.yml
conda activate vessel_boost
cd ../..
```


Or use the Docker container:
```bash
docker pull vnmd/vesselboost_2.0.1
```


#### eICAB (Circle of Willis Labeling)


```bash
git clone https://gitlab.com/felixdumais1/eicab.git external/eicab
cd external/eicab
pip install -r requirements.txt
cd ../..
```


#### HD-BET (Skull Stripping)


```bash
pip install hd-bet
```


On first run, HD-BET will download model weights (~65MB) to `~/hd-bet_params`.


#### VMTK (Centerline Extraction) — Optional


```bash
conda install -c vmtk vmtk
```


> **Note:** If VMTK is not installed, the pipeline automatically falls back to `skimage.morphology.skeletonize_3d` with `scipy.ndimage.distance_transform_edt`.


---


## Docker Deployment


### Build and run:


```bash
# Build the image
docker build -t cerebrovascular-api .


# Run with GPU support
docker run -d \
 --gpus all \
 -p 8000:8000 \
 --env-file .env \
 -v $(pwd)/output:/app/output \
 --name cerebrovascular \
 cerebrovascular-api
```


### Using Docker Compose:


```bash
docker-compose up -d
```


---


## Example Usage


### Upload a scan for analysis:


```bash
curl -X POST \
 -F "file=@/path/to/scan.nii.gz" \
 http://localhost:8000/analyze
```


**Response:**
```json
{
 "job_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
 "status": "processing",
 "message": "Analysis started for 'scan.nii.gz'. Poll GET /results/a1b2c3d4-e5f6-7890-abcd-ef1234567890 for results."
}
```


### Check results:


```bash
curl http://localhost:8000/results/a1b2c3d4-e5f6-7890-abcd-ef1234567890
```


### Health check:


```bash
curl http://localhost:8000/health
```


---


## Configuration


All thresholds are defined in `app/config.py`:


| Parameter | Default | Description |
|-----------|---------|-------------|
| `STENOSIS_MODERATE_THRESHOLD` | 50% | NASCET moderate stenosis cutoff |
| `STENOSIS_SEVERE_THRESHOLD` | 70% | NASCET severe stenosis cutoff |
| `ANEURYSM_SIZE_RATIO` | 1.6 | Size ratio threshold for aneurysm detection |
| `ANEURYSM_ASPECT_RATIO` | 1.2 | Aspect ratio threshold |
| `TORTUOSITY_DF_CUTOFF` | 1.5 | Distance Factor flagging threshold |
| `SVD_RATIO_CUTOFF` | 0.4 | SVD-suggestive ratio cutoff |
| `SVD_SMALL_VESSEL_RADIUS_MM` | 0.75 | Small vessel radius threshold |
| `TARGET_RESOLUTION_MM` | 0.5 | Isotropic resampling target |


---

## Testing


```bash
pip install pytest
pytest tests/ -v
```

---

## Authors

Hub Varith, Jason Ta, Dustin Liang, Vivian Chang


## Disclaimer


This output is generated by a research pipeline and **does not constitute clinical diagnosis**. All findings are algorithmic approximations intended for research purposes only. Clinical decisions should always be made by qualified medical professionals using validated diagnostic tools.


## Acknowledgements


- [VesselBoost](https://github.com/KMarshallX/VesselBoost) — Vessel segmentation
- [eICAB](https://gitlab.com/felixdumais1/eicab) — Circle of Willis labeling
- [HD-BET](https://github.com/MIC-DKFZ/HD-BET) — Brain extraction
- [VMTK](http://www.vmtk.org/) — Vascular modeling toolkit
- [Google Gemini](https://ai.google.dev/) — AI report generation
