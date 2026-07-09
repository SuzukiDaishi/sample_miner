"""AI モデルの利用可否検出。重い import は実行時まで遅延させる。"""
from __future__ import annotations

import importlib.util
from functools import lru_cache


def _has(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


@lru_cache(maxsize=1)
def model_availability() -> dict:
    torch_ok = _has("torch")
    device = "cpu"
    if torch_ok:
        try:
            import torch

            if torch.cuda.is_available():
                device = "cuda"
        except Exception:
            torch_ok = False
    return {
        "torch": torch_ok,
        "device": device,
        "demucs": torch_ok and _has("demucs"),
        "clap": torch_ok and _has("transformers"),
        "basicPitch": _has("basic_pitch"),
    }
