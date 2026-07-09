"""パイプライン統合テスト。
- 合成音での no-separation パイプライン(常時実行)
- datasets の実音源(存在する場合のみ)
"""
import json
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from app.pipeline.runner import run_pipeline

DATASET_DIR = Path(__file__).resolve().parents[3] / "datasets" / "学マス"


def _make_project(tmp_path: Path, y: np.ndarray, sr: int, name: str) -> Path:
    project_dir = tmp_path / "project_test"
    (project_dir / "source").mkdir(parents=True)
    sf.write(project_dir / "source" / name, y, sr)
    return project_dir


def _progress(stage: str, frac: float, message: str) -> None:
    pass


def test_pipeline_none_mode_synthetic(tmp_path):
    sr = 44100
    t = np.arange(int(sr * 4.0)) / sr
    # tone(0-1s) + クリック(2s, 2.5s) + 後半 drone
    y = np.zeros(len(t), dtype=np.float32)
    y[: sr] = 0.7 * np.sin(2 * np.pi * 220 * t[:sr])
    n = int(0.05 * sr)
    burst = (np.exp(-np.arange(n) / (0.005 * sr)) * np.sin(2 * np.pi * 3000 * np.arange(n) / sr)).astype(np.float32)
    for tt in (2.0, 2.5):
        s = int(tt * sr)
        y[s : s + n] += burst
    y[int(3.0 * sr) :] = 0.3 * np.sin(2 * np.pi * 110 * t[int(3.0 * sr) :])

    project_dir = _make_project(tmp_path, y, sr, "synthetic.wav")
    manifest = run_pipeline(project_dir, "synthetic.wav", "none", _progress)

    assert manifest["version"] == "0.1"
    assert (project_dir / "manifest.json").exists()
    assert (project_dir / "source" / "master.wav").exists()
    assert (project_dir / "tracks" / "original.wav").exists()
    assert len(manifest["segments"]) >= 2
    assert len(manifest["assets"]) == len(manifest["segments"])

    types = {a["type"] for a in manifest["assets"]}
    assert "PercussiveOneShot" in types

    # id は一意であること
    asset_ids = [a["id"] for a in manifest["assets"]]
    assert len(asset_ids) == len(set(asset_ids))
    seg_ids = [s["id"] for s in manifest["segments"]]
    assert len(seg_ids) == len(set(seg_ids))

    # rendered asset が実在する
    for a in manifest["assets"]:
        if a.get("renderedPath"):
            assert (project_dir / a["renderedPath"]).exists()

    # manifest が JSON として valid (NaN が混ざっていない)
    json.loads((project_dir / "manifest.json").read_text(encoding="utf-8"))


def _find_dataset_wav() -> Path | None:
    if not DATASET_DIR.exists():
        return None
    for sub in DATASET_DIR.iterdir():
        if sub.is_dir():
            for f in sub.iterdir():
                if f.suffix.lower() == ".wav":
                    return f
    return None


@pytest.mark.skipif(_find_dataset_wav() is None, reason="datasets not present")
def test_pipeline_none_mode_real_audio(tmp_path):
    src = _find_dataset_wav()
    data, sr = sf.read(src, always_2d=True, dtype="float32")
    excerpt = data[: sr * 20]  # 20 秒で十分
    project_dir = _make_project(tmp_path, excerpt, sr, "excerpt.wav")

    manifest = run_pipeline(project_dir, "excerpt.wav", "none", _progress)
    assert len(manifest["assets"]) > 3
    json.loads((project_dir / "manifest.json").read_text(encoding="utf-8"))
