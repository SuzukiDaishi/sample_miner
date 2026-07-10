"""Hook 反復検出 (docs 08 §3.2)。

曲のフックは繰り返される。原曲全体の beat-synchronous chroma
self-similarity から「時間軸上の反復強度マップ」を作り、各 segment が
曲中の反復領域(サビ・フック)にどれだけ重なるかを 0..1 で返す。
主観に依存しない、最も信頼できるキャッチーさシグナルとして
curate のランキングに使う。
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

MIN_TRACK_SEC = 20.0  # これ未満の音源では反復構造が測れない
HOP = 2048
STACK_STEPS = 4  # 時間文脈 (約1小節分の履歴) を持たせて偶然の一致を減らす


@dataclass
class HookMap:
    """boundaries[i]..boundaries[i+1] 秒の区間の反復強度が scores[i]。"""

    boundaries: np.ndarray  # (n+1,) 秒
    scores: np.ndarray  # (n,) 0..1


def compute_hook_map(y: np.ndarray, sr: int) -> HookMap | None:
    """原曲 mono から反復強度マップを作る。短すぎる/構造が取れない場合 None。"""
    import librosa

    if len(y) < sr * MIN_TRACK_SEC:
        return None

    chroma = librosa.feature.chroma_stft(y=y, sr=sr, hop_length=HOP)
    n_frames = chroma.shape[1]

    # beat-synchronous 化。beat が取れない素材 (環境音等) は 0.5s 固定グリッド
    _tempo, beats = librosa.beat.beat_track(y=y, sr=sr, hop_length=HOP)
    if len(beats) >= 16:
        idx = np.asarray(beats, dtype=int)
    else:
        step = max(1, int(round(0.5 * sr / HOP)))
        idx = np.arange(step, n_frames, step)
    idx = idx[(idx > 0) & (idx < n_frames)]
    if len(idx) < 12:
        return None

    sync = librosa.util.sync(chroma, idx)  # (12, len(idx)+1)
    sync = librosa.util.normalize(sync, axis=0)
    stacked = librosa.feature.stack_memory(sync, n_steps=STACK_STEPS, mode="edge")

    n = stacked.shape[1]
    width = min(STACK_STEPS, max(1, n // 8))  # 近傍対角 (自己近接) は反復に数えない
    try:
        rec = librosa.segment.recurrence_matrix(
            stacked, width=width, mode="affinity", metric="cosine", sym=True
        )
    except Exception:
        # 全編が同一内容 (完全一様なドローン等) だと affinity の bandwidth
        # 推定が失敗する。反復構造が測れない音源として扱う
        return None
    strength = np.asarray(rec.sum(axis=1), dtype=float).ravel()

    # percentile 正規化。全編反復のループ曲などで差が付かない場合は
    # 一律 0.5 (= hook 軸を実質無効化) にする (docs 08 §7)
    p10, p90 = np.percentile(strength, [10, 90])
    if p90 - p10 < 1e-9:
        scores = np.full(n, 0.5, dtype=float)
    else:
        scores = np.clip((strength - p10) / (p90 - p10), 0.0, 1.0)

    frame_times = librosa.frames_to_time(idx, sr=sr, hop_length=HOP)
    boundaries = np.concatenate(([0.0], frame_times, [len(y) / sr]))
    return HookMap(boundaries=boundaries, scores=scores)


def segment_hook_score(
    hook_map: HookMap, start_sec: float, end_sec: float
) -> float | None:
    """[start_sec, end_sec) の反復強度 (重なり時間の加重平均)。範囲外は None。"""
    lo = np.maximum(hook_map.boundaries[:-1], start_sec)
    hi = np.minimum(hook_map.boundaries[1:], end_sec)
    w = np.clip(hi - lo, 0.0, None)
    total = float(w.sum())
    if total <= 0:
        return None
    return float((w * hook_map.scores).sum() / total)
