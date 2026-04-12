"""Strip huge voxel arrays from a full API response JSON for fixtures."""
import json
import sys
from pathlib import Path


def main() -> None:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / ".." / "new nii data" / "response.json"
    dst = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parents[1] / "backend" / "fixtures" / "sample_api_response.json"
    d = json.loads(src.read_text(encoding="utf-8"))
    segs = d.get("binary_segments") or {}
    for _name, a in segs.items():
        if not isinstance(a, dict):
            continue
        if "data" in a:
            n = a.get("voxel_count", len(a["data"]) if isinstance(a.get("data"), list) else 0)
            a["data"] = f"<{n} voxels omitted>"
        cl = a.get("centerline")
        if isinstance(cl, list) and len(cl) > 24:
            a["centerline"] = cl[:12] + ["..."]
    out = {k: d[k] for k in ("job_id", "status", "binary_segments", "risk_scores", "narrative_summary") if k in d}
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(dst, dst.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
