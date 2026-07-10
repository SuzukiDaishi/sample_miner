"""個人 ranker (docs 08 §3.4 D-2)。

ユーザーの keep/discard 判定 (userRating) を教師に、CLAP audio embedding 上の
ロジスティック回帰で「その人にとってのキャッチーさ」を学習する。
学習は scripts/train_ranker.py、推論は runner が personalScore として stamp する。
依存は numpy のみ (sklearn/torch 不要) — 推論は torch 無し環境でも動く。
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

WEIGHTS_VERSION = 1


def _sigmoid(z: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(z, -30.0, 30.0)))


def train_logreg(
    X: np.ndarray,
    y: np.ndarray,
    l2: float = 1.0,
    lr: float = 0.5,
    epochs: int = 800,
) -> tuple[np.ndarray, float]:
    """full-batch 勾配降下のロジスティック回帰。(w, b) を返す。

    L = -(1/n) Σ [y log σ + (1-y) log(1-σ)] + (l2/(2n))‖w‖²  (bias は正則化しない)
    n は高々数百・d=512 なので GD で十分速い。
    """
    X = np.asarray(X, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    n, d = X.shape
    w = np.zeros(d)
    b = 0.0
    for _ in range(epochs):
        err = _sigmoid(X @ w + b) - y
        w -= lr * (X.T @ err / n + l2 / n * w)
        b -= lr * float(err.mean())
    return w, b


def predict_proba(x: np.ndarray, w: np.ndarray, b: float) -> np.ndarray | float:
    """σ(x·w + b)。x は (d,) または (n, d)。"""
    x = np.asarray(x, dtype=np.float64)
    z = x @ np.asarray(w, dtype=np.float64) + b
    p = _sigmoid(np.atleast_1d(z))
    return float(p[0]) if z.ndim == 0 else p


def save_weights(path: Path, w: np.ndarray, b: float, meta: dict) -> None:
    payload = {
        "version": WEIGHTS_VERSION,
        "dim": int(len(w)),
        "w": [float(v) for v in w],
        "b": float(b),
        **meta,
    }
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def load_weights(path: Path) -> dict | None:
    """weights JSON を読む。欠損・破損は None (ranker 無効として扱う)。"""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        if data.get("version") != WEIGHTS_VERSION:
            return None
        data["w"] = np.asarray(data["w"], dtype=np.float64)
        if len(data["w"]) != data.get("dim"):
            return None
        return data
    except Exception:
        return None
