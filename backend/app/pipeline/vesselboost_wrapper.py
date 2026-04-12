"""
vesselboost_wrapper.py — Thin wrapper around the VesselBoost CLI.

Responsibility: take a NIfTI path in, return a binary vessel mask as a
numpy array (plus its affine + voxel size). Nothing else. All downstream
geometric analysis lives in VesselPipeline.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import nibabel as nib
import numpy as np

from app.config import VESSELBOOST_DIR, VESSELBOOST_MODEL_DIR
from app.utils.nifti_utils import get_data, get_voxel_size, load_nifti, save_nifti

logger = logging.getLogger(__name__)


@dataclass
class VesselMask:
    """Binary vessel mask + spatial metadata. Returned by VesselBoostWrapper."""
    array: np.ndarray              # uint8, shape (X, Y, Z), values 0/1
    affine: np.ndarray             # (4, 4)
    voxel_size: tuple[float, ...]  # mm per voxel
    source_path: Path              # path the mask was saved to


class VesselBoostWrapper:
    """
    Calls VesselBoost's prediction.py (local install or Docker), then
    returns the result as a numpy array via `segment()`.

    Usage:
        wrapper = VesselBoostWrapper(model_dir=VESSELBOOST_MODEL_DIR)
        mask = wrapper.segment("scan.nii.gz", out_dir="/tmp/job1", job_id="job1")
        # mask.array is a uint8 ndarray
    """

    def __init__(
        self,
        repo_dir: Path = VESSELBOOST_DIR,
        model_dir: Path = VESSELBOOST_MODEL_DIR,
        prep_mode: int = 4,
        timeout_s: int = 1800,
        python: str = sys.executable,
    ):
        self.repo_dir = Path(repo_dir)
        self.model_dir = Path(model_dir)
        self.prep_mode = prep_mode
        self.timeout_s = timeout_s
        self.python = python
        self.script = self.repo_dir / "prediction.py"

    # ---------- public API ----------

    def is_available(self) -> bool:
        return self.script.exists() and self._resolve_model_path() is not None

    def segment(
        self,
        input_path: str | Path,
        out_dir: str | Path,
        job_id: str,
    ) -> VesselMask:
        """Run VesselBoost and return the binary mask as a numpy array."""
        out_dir = Path(out_dir); out_dir.mkdir(parents=True, exist_ok=True)
        mask_path = out_dir / f"{job_id}_vessel_mask.nii.gz"
        logger.info(
            "Running VesselBoost on %s -> %s (prep_mode=%s)",
            input_path,
            mask_path,
            self.prep_mode,
        )

        if self.is_available() and self._run_local(input_path, out_dir, job_id, mask_path):
            logger.info(f"VesselBoost (local) succeeded → {mask_path}")
        elif self._run_docker(input_path, out_dir, mask_path):
            logger.info(f"VesselBoost (docker) succeeded → {mask_path}")
        else:
            logger.warning(
                "VesselBoost unavailable; using Otsu fallback. "
                "Checked script=%s, model_root=%s, resolved_model=%s",
                self.script.exists(),
                self.model_dir,
                self._resolve_model_path(),
            )
            self._fallback_otsu(input_path, mask_path)

        return self._load_as_vessel_mask(mask_path)

    # ---------- internals ----------

    def _resolve_model_path(self) -> Path | None:
        """
        Resolve a concrete pretrained model artifact from the configured path.

        VesselBoost expects `--pretrained` to point to a model file or model
        artifact path, not the containing `saved_models/` directory.
        """
        path = self.model_dir
        if path.is_file():
            return path
        if not path.exists():
            return None

        preferred_names = [
            "manual_0429",
            "BM_VB2_aug_all_ep2k_bat_10_0903",
            "VB2_aug_off_ep2k_bat10_0903",
            "VB2_aug_random_ep2k_bat10_0903",
            "VB2_aug_intensity_ep2k_bat10_0903",
            "VB2_aug_spatial_ep2k_bat10_0903",
        ]
        for name in preferred_names:
            candidate = path / name
            if candidate.exists():
                return candidate

        file_candidates = sorted(
            p for p in path.iterdir()
            if p.is_file() and p.suffix.lower() in {".pt", ".pth", ".ckpt", ".bin", ""}
        )
        if len(file_candidates) == 1:
            return file_candidates[0]
        return None

    def _build_prediction_cmd(
        self,
        input_dir: Path,
        pred_dir: Path,
        pretrained_model: Path,
        preprocessed_dir: Path | None = None,
    ) -> list[str]:
        input_dir = input_dir.resolve()
        pred_dir = pred_dir.resolve()
        pretrained_model = pretrained_model.resolve()
        cmd = [
            self.python, str(self.script),
            "--image_path", str(input_dir),
            "--output_path", str(pred_dir),
            "--pretrained", str(pretrained_model),
            "--prep_mode", str(self.prep_mode),
        ]
        if self.prep_mode != 4:
            if preprocessed_dir is None:
                raise ValueError("preprocessed_dir is required when prep_mode != 4")
            cmd.extend(["--preprocessed_path", str(preprocessed_dir.resolve())])
        return cmd

    def _run_local(self, input_path, out_dir, job_id, mask_path) -> bool:
        pretrained_model = self._resolve_model_path()
        if pretrained_model is None:
            logger.warning(
                "VesselBoost local run skipped: no pretrained model found under %s. "
                "Set VESSELBOOST_MODEL_DIR to a concrete model path or a directory "
                "containing `manual_0429` or another pretrained model artifact.",
                self.model_dir,
            )
            return False

        pred_dir = Path(out_dir) / f"{job_id}_vb_pred"
        pred_dir.mkdir(parents=True, exist_ok=True)
        input_dir = pred_dir / "input"
        input_dir.mkdir(parents=True, exist_ok=True)
        staged_input = input_dir / Path(input_path).name
        if not staged_input.exists():
            shutil.copy2(input_path, staged_input)
        preprocessed_dir = pred_dir / "preprocessed"
        if self.prep_mode != 4:
            preprocessed_dir.mkdir(parents=True, exist_ok=True)

        cmd = self._build_prediction_cmd(
            input_dir=input_dir,
            pred_dir=pred_dir,
            pretrained_model=pretrained_model,
            preprocessed_dir=preprocessed_dir if self.prep_mode != 4 else None,
        )
        try:
            env = os.environ.copy()
            pythonpath = env.get("PYTHONPATH")
            env["PYTHONPATH"] = str(self.repo_dir) if not pythonpath else f"{self.repo_dir}{os.pathsep}{pythonpath}"
            logger.info("VesselBoost local prediction started.")
            returncode, combined_output = self._run_logged_subprocess(
                cmd,
                cwd=self.repo_dir,
                env=env,
                timeout=self.timeout_s,
                log_prefix="VesselBoost",
            )
            if returncode != 0:
                logger.warning(
                    "VesselBoost failed: %s",
                    (combined_output.strip() or "unknown error")[:1000],
                )
                return False
            outs = sorted(
                [
                    p for p in pred_dir.iterdir()
                    if p.is_file() and (p.name.endswith(".nii") or p.name.endswith(".nii.gz"))
                ],
                key=lambda p: p.stat().st_mtime,
            )
            if not outs:
                logger.warning("VesselBoost produced no NIfTI outputs in %s", pred_dir)
                return False
            self._binarize_and_save(outs[-1], mask_path)
            return True
        except Exception as e:
            logger.warning(f"VesselBoost local error: {e}")
            return False

    def _run_docker(self, input_path, out_dir, mask_path) -> bool:
        if shutil.which("docker") is None:
            return False
        try:
            ip, od = Path(input_path).resolve(), Path(out_dir).resolve()
            cmd = [
                "docker", "run", "--rm",
                "-v", f"{ip.parent}:/input", "-v", f"{od}:/output",
                "vnmd/vesselboost_2.0.1",
                "python", "/opt/VesselBoost/prediction.py",
                "--image_path", f"/input/{ip.name}",
                "--output_path", "/output",
                "--pretrained", "/opt/VesselBoost/saved_models/manual_0429",
                "--prep_mode", str(self.prep_mode),
            ]
            if self.prep_mode != 4:
                cmd.extend(["--preprocessed_path", "/output/preprocessed"])
            logger.info("VesselBoost docker prediction started.")
            returncode, combined_output = self._run_logged_subprocess(
                cmd,
                timeout=self.timeout_s,
                log_prefix="VesselBoost Docker",
            )
            if returncode != 0:
                logger.warning(
                    "VesselBoost docker failed: %s",
                    (combined_output.strip() or "unknown error")[:1000],
                )
                return False
            outs = [
                p for p in od.iterdir()
                if p.is_file() and (p.name.endswith(".nii") or p.name.endswith(".nii.gz"))
            ]
            if not outs:
                logger.warning("VesselBoost docker produced no NIfTI outputs in %s", od)
                return False
            self._binarize_and_save(outs[0], mask_path)
            return True
        except Exception as e:
            logger.warning(f"VesselBoost docker error: {e}")
            return False

    def _run_logged_subprocess(
        self,
        cmd: list[str],
        cwd: Path | None = None,
        env: dict[str, str] | None = None,
        timeout: int | None = None,
        log_prefix: str = "subprocess",
    ) -> tuple[int, str]:
        """Run a subprocess and forward progress lines into the app logger."""
        process = subprocess.Popen(
            cmd,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        output_chunks: list[str] = []
        try:
            assert process.stdout is not None
            for raw_line in process.stdout:
                output_chunks.append(raw_line)
                for part in raw_line.replace("\r", "\n").splitlines():
                    line = part.strip()
                    if not line:
                        continue
                    logger.info("%s: %s", log_prefix, line)
            returncode = process.wait(timeout=timeout)
            return returncode, "".join(output_chunks)
        except subprocess.TimeoutExpired:
            process.kill()
            raise

    def _binarize_and_save(self, src: Path, dst: Path) -> None:
        img = load_nifti(src)
        binary = (get_data(img) > 0.5).astype(np.uint8)
        save_nifti(binary, img.affine, dst, header=img.header)

    def _fallback_otsu(self, input_path, mask_path) -> None:
        from scipy import ndimage
        from skimage.filters import threshold_otsu
        from skimage.morphology import remove_small_objects
        img = load_nifti(input_path); data = get_data(img)
        nz = data[data > 0]
        thr = threshold_otsu(nz) if len(nz) else 0
        m = data > thr
        m = ndimage.binary_closing(m, iterations=1)
        m = ndimage.binary_opening(m, iterations=1)
        m = remove_small_objects(m, min_size=50)
        save_nifti(m.astype(np.uint8), img.affine, mask_path, header=img.header)

    def _load_as_vessel_mask(self, mask_path: Path) -> VesselMask:
        img = load_nifti(mask_path)
        return VesselMask(
            array=get_data(img).astype(np.uint8),
            affine=img.affine,
            voxel_size=get_voxel_size(img),
            source_path=Path(mask_path),
        )
