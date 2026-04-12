# VascuSense

A Python FastAPI backend for automated cerebrovascular arterial blood vessel analysis from TOF-MRA neuroimaging data. Upload a raw NIfTI file and receive a full structured analysis including vessel segmentation, artery labeling, stenosis/aneurysm/tortuosity detection, small vessel disease metrics, AI-generated clinical narrative, and rule-based risk scores.

## Inspiration:
Cerebrovascular disease remains the second leading cause of death globally, claiming seven million lives annually. While the precursors to stroke are often detectable on MRI scans years in advance, identifying these subtle markers is a monumental challenge. A single scan comprises half a billion voxels, yet the critical vessels represent less than one percent of that volume. For radiologists, this is a search for a needle in a digital haystack where the smallest findings are easily overlooked. We developed a solution to automate this search to provide a level of speed and precision that manual review simply cannot sustain.

## What it does:
VascuSense is a cerebrovascular imaging analysis platform that transforms raw TOF-MRA neuroimaging data into a high-fidelity map of arterial health. By automating the segmentation and anatomical labeling of the Circle of Willis, the system performs a rigorous geometric analysis to detect critical structural risk features, including arterial stenosis, aneurysm candidates, tortuosity, and occlusions. Each detected anomaly is precisely scored and rendered in a detailed 3D environment, providing clinicians with an intuitive spatial understanding of where risks are located within the vessel tree. This analysis culminates in a generated clinical narrative that translates complex volumetric data into a concise summary of findings, ensuring that subtle warning signs are not only identified but effectively communicated for clinical decision-making.

## How we built it:
The VascuSense architecture initiates with taking in .NIfTI data and utilizes the VesselBoost library to execute N4 bias correction, denoising, and high precision segmentation. Once a binary mask is established, the system employs eICAB or atlas based labeling to categorize major arterial segments, which provides the anatomical context required for skeletonization and distance transforms. By calculating the distance to the nearest boundary at each voxel, the system determines the true radius throughout the vessel tree, transforming the data into a queryable graph where nodes represent branch points and edges carry anatomical labels. The platform then grades arterial stenosis via the NASCET method by calculating narrowing as a percentage relative to a healthy distal segment. It further quantifies tortuosity through both the Distance Factor, defined as the ratio of actual path length to Euclidean distance, and the Sum of Angles Metric, which measures the cumulative angular change along the vessel. To assess small vessel disease, the system maps the data into the Montreal Neurological Institute coordinate system to evaluate vessel density within standardized regions of interest as a diagnostic proxy. Ultimately, these clinical features are synthesized into visual axial and coronal overlays and a Gemini API generated analysis. Subsequently, the system outputs probabilities for large vessel stroke, lacunar events, and aneurysm rupture.

## Challenges we ran into:
*Defining the correct json schema for communication between frontend and backend

*Difficulty rendering the MRI since we had to write an algorithm that takes the slices and combine them into a 3D rendering

*Trying to understand the biological aspect of this project, and evaluating what each metrics tell you before starting to build the data pipeline & processing. Without thorough understanding, we would be working in the blind and not know the structure of how data would be communicated between each module

*Getting the local packages running. E.g. eICAP package installation reqauirements took a lot of debugging

*Trying to build a deployable backend without knowing the computational complexity & took us a long time before we realize that we could create a mock json response (adhering to the schema), which contains real masking data from the data pipeline, and parsing the json data in the frontend instead of having to call the backend, since it took a very long time to run a predictive computational model on a CPU.

## Accomplishments that we're proud of:
We were able to build a functional prototype from real MRI data that has been processed through the data computational pipeline in the backend. The backend was structured so that it would be easier to scale and deploy to GPU VMs in the future. Finally, we were able to render the masked data through three.js and were able to achieve in-depth analysis, which has similar findings to the labels of the sample MRI image derived from the dataset.

## What we learned:
*Always test and find out the computational complexity / processing time of a pre-trained model before deciding on a communications protocol. E.g. Websocket would've been better for algorithms with higher processing time.
*It is very essential to understand the metrics, and how the data is manipulated through each stage of the data processing pipeline. This would give a clear intuitive view of how we can manipulate and extrapolate meaningful information from the data for further analysis.
*Always write out the software architecture with the team before starting to code. It is very important to explore libraries & concept, then come up with a solid schema for both frontend and backend to adhere to.

## What's next for Cerebrovascular arterial blood vessel analysis:
Future developments will focus on rendering masked vessels directly onto the MRI volume using interactive controls to provide clinicians with comprehensive radiological context rather than an isolated 3D model. We'd like to establish a backend on a GPU-backed virtual machine since inference times must be reduced to support real-time diagnostic workflows. Furthermore, we aim to validate our anomaly scoring protocols against gold standard annotated datasets and explore the capacity of graph representations to facilitate longitudinal analysis. By tracking subtle shifts in vessel geometry across sequential scans, the platform could eventually monitor the progression of vascular disease over time. We also need to take measures to ensure HIPAA compliance for the future.

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
