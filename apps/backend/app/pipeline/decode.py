"""ffmpeg decode → master.wav 48kHz + 解析用 mono。docs 03 §1 準拠。"""
from __future__ import annotations

import subprocess
from functools import lru_cache
from pathlib import Path

import numpy as np
import soundfile as sf

from ..config import MASTER_SAMPLE_RATE


@lru_cache(maxsize=1)
def ffmpeg_available() -> bool:
    """PATH 上の存在ではなく実際に起動できるかで判定する
    (winget の壊れた実行エイリアスが DLL 欠損で失敗するケースがある)。"""
    try:
        proc = subprocess.run(
            ["ffmpeg", "-version"], capture_output=True, timeout=10
        )
        return proc.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def decode_to_master(input_path: Path, master_path: Path) -> None:
    """任意フォーマットを 48kHz float32 wav へ変換する。"""
    master_path.parent.mkdir(parents=True, exist_ok=True)
    if ffmpeg_available():
        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(input_path),
            "-ac",
            "2",
            "-ar",
            str(MASTER_SAMPLE_RATE),
            "-c:a",
            "pcm_f32le",
            str(master_path),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg failed: {proc.stderr[-500:]}")
        return

    # ffmpeg 無し: soundfile (libsndfile) で読める形式のみ対応 (wav/flac/mp3/ogg)
    data, sr = sf.read(input_path, always_2d=True, dtype="float32")
    if sr != MASTER_SAMPLE_RATE:
        import librosa

        data = librosa.resample(
            data.T, orig_sr=sr, target_sr=MASTER_SAMPLE_RATE
        ).T
    if data.shape[1] == 1:
        data = np.repeat(data, 2, axis=1)
    sf.write(master_path, data, MASTER_SAMPLE_RATE, subtype="FLOAT")


def load_wav(path: Path) -> tuple[np.ndarray, int]:
    """wav → (channels, samples) float32 と sample rate。"""
    data, sr = sf.read(path, always_2d=True, dtype="float32")
    return data.T.copy(), sr


def to_mono(channels: np.ndarray) -> np.ndarray:
    return channels.mean(axis=0).astype(np.float32)
