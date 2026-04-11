"""
test_health.py — Basic endpoint tests for the cerebrovascular analysis API.
"""

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


class TestHealthEndpoint:
    """Tests for GET /health."""

    def test_health_returns_200(self):
        response = client.get("/health")
        assert response.status_code == 200

    def test_health_returns_status(self):
        response = client.get("/health")
        data = response.json()
        assert "status" in data
        assert data["status"] == "healthy"

    def test_health_includes_gpu_info(self):
        response = client.get("/health")
        data = response.json()
        assert "gpu_available" in data
        assert isinstance(data["gpu_available"], bool)


class TestAnalyzeEndpoint:
    """Tests for POST /analyze."""

    def test_analyze_rejects_invalid_extension(self):
        """Uploading a non-NIfTI file should return 400."""
        response = client.post(
            "/analyze",
            files={"file": ("test.txt", b"not a nifti file", "text/plain")},
        )
        assert response.status_code == 400
        assert "Invalid file format" in response.json()["detail"]

    def test_analyze_rejects_no_file(self):
        """Missing file should return 422."""
        response = client.post("/analyze")
        assert response.status_code == 422


class TestResultsEndpoint:
    """Tests for GET /results/{job_id}."""

    def test_results_not_found(self):
        """Non-existent job ID should return 404."""
        response = client.get("/results/nonexistent-job-id")
        assert response.status_code == 404

    def test_results_returns_job_not_found_message(self):
        response = client.get("/results/fake-uuid-12345")
        data = response.json()
        assert "not found" in data["detail"].lower()
