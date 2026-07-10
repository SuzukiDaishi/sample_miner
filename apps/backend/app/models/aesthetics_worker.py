"""Audiobox-Aesthetics worker (docs 08 §3.4 D-1)。

CE (Content Enjoyment) / PQ (Production Quality) などの美的評価軸を予測し、
正規化した aesScore としてキャッチーさの blend に使う。
決定には使わず弱いシグナルとして加点するのみ (docs 07 §6 の方針を維持)。
"""
from __future__ import annotations

import numpy as np

_state: dict = {}


def normalize_aesthetics(ce: float, pq: float) -> float:
    """CE/PQ (公称 1..10) → 0..1。純関数 (torch 不要)。

    (CE+PQ)/2 は実測でほぼ 2..8 に分布するため、その範囲を線形マップして clip。
    """
    return float(min(1.0, max(0.0, ((ce + pq) / 2.0 - 2.0) / 6.0)))


def _get_predictor():
    if not _state:
        from audiobox_aesthetics.infer import initialize_predictor

        _state["predictor"] = initialize_predictor()
    return _state["predictor"]


def score_audio(y: np.ndarray, sr: int) -> dict | None:
    """mono buffer → {"CE","CU","PC","PQ"} (~1..10)。短すぎる入力は None。"""
    import torch

    if len(y) < sr // 10:
        return None
    predictor = _get_predictor()
    wav = torch.from_numpy(np.ascontiguousarray(y, dtype=np.float32)).unsqueeze(0)
    result = predictor.forward([{"path": wav, "sample_rate": sr}])[0]
    return {k: float(result[k]) for k in ("CE", "CU", "PC", "PQ") if k in result}
