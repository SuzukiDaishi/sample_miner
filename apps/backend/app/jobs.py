"""非同期 job 管理 (docs 03 パフォーマンス方針)。
重い解析は ThreadPoolExecutor(1 worker) で直列実行し、GPU の同時使用を防ぐ。
"""
from __future__ import annotations

import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from .pipeline.curate import curate_project
from .pipeline.runner import run_pipeline
from .pipeline.trackbuild import build_track


@dataclass
class Job:
    id: str
    project_id: str
    status: str = "queued"  # queued | running | done | error
    stage: str = ""
    progress: float = 0.0
    message: str = ""
    error: str | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "projectId": self.project_id,
            "status": self.status,
            "stage": self.stage,
            "progress": self.progress,
            "message": self.message,
            "error": self.error,
        }


class JobManager:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._executor = ThreadPoolExecutor(max_workers=1)

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def submit_analysis(
        self, project_dir: Path, original_filename: str, mode: str
    ) -> Job:
        job = Job(id=uuid.uuid4().hex[:12], project_id=project_dir.name)
        with self._lock:
            self._jobs[job.id] = job

        def progress(stage: str, frac: float, message: str) -> None:
            with self._lock:
                job.stage = stage
                job.progress = round(frac, 3)
                job.message = message

        def work() -> None:
            with self._lock:
                job.status = "running"
            try:
                run_pipeline(project_dir, original_filename, mode, progress)
                with self._lock:
                    job.status = "done"
                    job.progress = 1.0
            except Exception as e:
                with self._lock:
                    job.status = "error"
                    job.error = f"{e}\n{traceback.format_exc()[-1000:]}"

        self._executor.submit(work)
        return job

    def submit_track(self, project_dir: Path, bars: int, seed: int) -> Job:
        """キュレーション → トラック自動組み立て job。"""
        job = Job(id=uuid.uuid4().hex[:12], project_id=project_dir.name)
        with self._lock:
            self._jobs[job.id] = job

        def set_progress(stage: str, frac: float, message: str) -> None:
            with self._lock:
                job.stage = stage
                job.progress = round(frac, 3)
                job.message = message

        def work() -> None:
            with self._lock:
                job.status = "running"
            try:
                set_progress("curate", 0.1, "素材を選定中")
                curated_dir = project_dir / "curated"
                curate_project(project_dir, curated_dir)
                set_progress("build", 0.5, "トラックを組み立て中")
                build_track(
                    project_dir,
                    curated_dir,
                    project_dir / "track",
                    bars=bars,
                    seed=seed,
                )
                with self._lock:
                    job.status = "done"
                    job.stage = "done"
                    job.progress = 1.0
            except Exception as e:
                with self._lock:
                    job.status = "error"
                    job.error = f"{e}\n{traceback.format_exc()[-1000:]}"

        self._executor.submit(work)
        return job


job_manager = JobManager()
