"""stem 別チョップ。docs 03 §4:
drums = onset 強め / vocals = 無音区間 / bass,melodic = onset+pitch /
ambient = 長い安定区間。
"""
from __future__ import annotations

from dataclasses import dataclass

import librosa
import numpy as np

from ..config import MAX_SEGMENTS_PER_TRACK


@dataclass
class RawSegment:
    start: int  # samples
    end: int
    onset: int
    method: str  # "onset" | "silence" | "manual"


def _rms_env(y: np.ndarray, win: int) -> np.ndarray:
    n = max(1, len(y) // win)
    trimmed = y[: n * win].reshape(n, win)
    return np.sqrt((trimmed**2).mean(axis=1))


def _tail_end(y: np.ndarray, start: int, end_limit: int, db_drop: float = 40.0) -> int:
    """peak RMS から db_drop 下がる位置で tail を切る。"""
    win = 256
    seg = y[start:end_limit]
    if len(seg) < win * 2:
        return end_limit
    env = _rms_env(seg, win)
    peak_i = int(np.argmax(env))
    peak = env[peak_i]
    if peak <= 0:
        return end_limit
    threshold = peak * 10 ** (-db_drop / 20)
    below = np.nonzero(env[peak_i + 1 :] < threshold)[0]
    if len(below) == 0:
        return end_limit
    return start + (peak_i + 1 + int(below[0]) + 1) * win


def segment_track(y: np.ndarray, sr: int, kind: str) -> list[RawSegment]:
    """kind: drums / vocals / bass / other / original"""
    duration = len(y) / sr
    if duration < 0.05 or float(np.abs(y).max()) < 1e-4:
        return []

    pre = int(0.005 * sr)

    if kind == "vocals":
        # 無音区間ベース (docs: vocals は無音区間 / syllable 重視)。
        # ブレス程度の短いギャップ (<0.35s) は結合してフレーズを途中で切らない。
        intervals = librosa.effects.split(y, top_db=30, frame_length=2048, hop_length=512)
        merged: list[list[int]] = []
        max_gap = int(0.35 * sr)
        for s, e in intervals:
            if merged and int(s) - merged[-1][1] < max_gap:
                merged[-1][1] = int(e)
            else:
                merged.append([int(s), int(e)])

        release = int(0.15 * sr)  # 語尾の余韻を残す
        segments = []
        for s, e in merged[:MAX_SEGMENTS_PER_TRACK]:
            s2 = max(0, s - pre)
            e2 = min(len(y), e + release)
            if e2 - s2 < int(0.05 * sr):
                continue
            segments.append(RawSegment(s2, e2, s, "silence"))
        return segments

    # onset ベース
    if kind == "drums":
        params = dict(pre_max=3, post_max=3, pre_avg=8, post_avg=8, delta=0.05, wait=2)
        max_dur = 2.0
    else:
        params = dict(pre_max=6, post_max=6, pre_avg=16, post_avg=16, delta=0.07, wait=4)
        max_dur = 10.0

    onsets = librosa.onset.onset_detect(
        y=y, sr=sr, hop_length=512, backtrack=True, units="samples", **params
    )
    # 最小間隔 60ms
    filtered: list[int] = []
    min_gap = int(0.06 * sr)
    for o in onsets:
        if not filtered or o - filtered[-1] >= min_gap:
            filtered.append(int(o))

    if not filtered:
        # onset なし → 全体を 1 segment (drone/ambience 候補)
        return [RawSegment(0, len(y), 0, "onset")]

    segments = []
    for i, o in enumerate(filtered[:MAX_SEGMENTS_PER_TRACK]):
        start = max(0, o - pre)
        next_limit = filtered[i + 1] - pre if i + 1 < len(filtered) else len(y)
        end_limit = min(len(y), next_limit, o + int(max_dur * sr))
        end = _tail_end(y, start, end_limit)
        if end - start < int(0.03 * sr):
            continue
        segments.append(RawSegment(start, end, o, "onset"))
    return segments
