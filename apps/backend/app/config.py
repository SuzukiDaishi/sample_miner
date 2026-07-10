"""バックエンド設定。"""
from __future__ import annotations

import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent

PROJECTS_DIR = Path(
    os.environ.get("SAMPLE_MINER_PROJECTS_DIR", BACKEND_DIR / "projects")
)
PROJECTS_DIR.mkdir(parents=True, exist_ok=True)

# 個人 ranker の重み (docs 08 §3.4 D-2)。scripts/train_ranker.py が生成する
RANKER_PATH = Path(
    os.environ.get("SAMPLE_MINER_RANKER_PATH", BACKEND_DIR / "ranker_weights.json")
)

MASTER_SAMPLE_RATE = 48000
ANALYSIS_SAMPLE_RATE = 22050

# 1 曲あたりの生成上限(暴走防止)
MAX_SEGMENTS_PER_TRACK = 128
MAX_WAVETABLES = 12
MAX_DRONES = 8
MAX_MIDI = 8
