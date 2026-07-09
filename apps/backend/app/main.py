"""AI Sample Miner — Full Backend (FastAPI)。docs 03 の Webバックエンド型。

起動:
  .venv\\Scripts\\python -m uvicorn app.main:app --port 8000
"""
from __future__ import annotations

import json
import re
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from .config import PROJECTS_DIR
from .jobs import job_manager
from .models.availability import model_availability

app = FastAPI(title="AI Sample Miner Backend", version="0.1")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

MODES = ("auto", "music", "field", "voice", "none")


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "models": model_availability()}


@app.post("/api/projects")
async def create_project(
    file: UploadFile = File(...),
    mode: str = Form("auto"),
) -> dict:
    if mode not in MODES:
        raise HTTPException(400, f"invalid mode: {mode}")

    project_id = f"project_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"
    project_dir = PROJECTS_DIR / project_id
    source_dir = project_dir / "source"
    source_dir.mkdir(parents=True, exist_ok=True)

    # ファイル名を安全化 (拡張子は保持)
    original = Path(file.filename or "input.wav")
    safe_name = re.sub(r"[^\w\-.]+", "_", original.name) or "input.wav"
    dest = source_dir / safe_name
    with dest.open("wb") as f:
        while chunk := await file.read(1 << 20):
            f.write(chunk)

    job = job_manager.submit_analysis(project_dir, safe_name, mode)
    return {"projectId": project_id, "jobId": job.id, "mode": mode}


@app.post("/api/projects/{project_id}/track")
def create_track(
    project_id: str,
    bars: int = Form(16),
    seed: int = Form(0),
) -> dict:
    """解析済みプロジェクトからトラック(mix + stems)を自動組み立てる。"""
    project_dir = _project_dir(project_id)
    if not (project_dir / "manifest.json").exists():
        raise HTTPException(409, "project not analyzed yet")
    if bars not in (4, 8, 16, 32):
        raise HTTPException(400, "bars must be 4/8/16/32")
    job = job_manager.submit_track(project_dir, bars, seed)
    return {"projectId": project_id, "jobId": job.id, "bars": bars, "seed": seed}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = job_manager.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    return job.to_dict()


@app.get("/api/projects")
def list_projects() -> list[dict]:
    out = []
    for d in sorted(PROJECTS_DIR.iterdir(), reverse=True):
        if d.is_dir():
            out.append(
                {"projectId": d.name, "hasManifest": (d / "manifest.json").exists()}
            )
    return out


def _project_dir(project_id: str) -> Path:
    if not re.fullmatch(r"[\w\-]+", project_id):
        raise HTTPException(400, "invalid project id")
    d = PROJECTS_DIR / project_id
    if not d.is_dir():
        raise HTTPException(404, "project not found")
    return d


@app.get("/api/projects/{project_id}/manifest")
def get_manifest(project_id: str) -> JSONResponse:
    path = _project_dir(project_id) / "manifest.json"
    if not path.exists():
        raise HTTPException(404, "manifest not ready")
    return JSONResponse(content=json.loads(path.read_text(encoding="utf-8")))


@app.get("/api/projects/{project_id}/files/{file_path:path}")
def get_file(project_id: str, file_path: str) -> FileResponse:
    project_dir = _project_dir(project_id)
    target = (project_dir / file_path).resolve()
    if not str(target).startswith(str(project_dir.resolve())):
        raise HTTPException(400, "invalid path")
    if not target.is_file():
        raise HTTPException(404, "file not found")
    media = "audio/wav" if target.suffix == ".wav" else "application/octet-stream"
    if target.suffix == ".json":
        media = "application/json"
    if target.suffix == ".mid":
        media = "audio/midi"
    return FileResponse(target, media_type=media)
