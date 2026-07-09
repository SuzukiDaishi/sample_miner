"""drone / ambience loop 生成 (docs 03 §8)。
score = waveform_endpoint*0.4 + rms*0.2 + spectral*0.3 + transient*0.1
フル版は spectral 距離に MFCC も併用する。
"""
from __future__ import annotations

from dataclasses import dataclass

import librosa
import numpy as np


@dataclass
class LoopResult:
    start: int
    end: int
    crossfade_ms: int
    score: float


def _spectrum(y: np.ndarray, center: int, size: int = 2048) -> np.ndarray:
    s = int(np.clip(center - size // 2, 0, max(0, len(y) - size)))
    frame = y[s : s + size] * np.hanning(size)
    return np.abs(np.fft.rfft(frame))


def _mfcc_at(y: np.ndarray, sr: int, center: int, size: int = 4096) -> np.ndarray:
    s = int(np.clip(center - size // 2, 0, max(0, len(y) - size)))
    chunk = y[s : s + size]
    return librosa.feature.mfcc(y=chunk, sr=sr, n_mfcc=13).mean(axis=1)


def find_best_loop(
    y: np.ndarray,
    sr: int,
    spectral_flatness: float,
    min_loop_sec: float = 1.0,
    max_loop_sec: float = 8.0,
    start_candidates: int = 16,
    length_candidates: int = 12,
) -> LoopResult | None:
    duration = len(y) / sr
    min_loop = int(min_loop_sec * sr)
    max_loop = int(min(max_loop_sec, duration * 0.9) * sr)
    if max_loop <= min_loop:
        return None

    crossfade_ms = 250 if spectral_flatness > 0.3 else 60
    crossfade = int(crossfade_ms / 1000 * sr)

    rms_win = int(0.05 * sr)
    env_win = 512
    n_env = max(1, len(y) // env_win)
    env = np.sqrt((y[: n_env * env_win].reshape(n_env, env_win) ** 2).mean(axis=1))
    env_mean = float(env.mean())

    def rms_at(c: int) -> float:
        s = int(np.clip(c - rms_win // 2, 0, max(0, len(y) - rms_win)))
        return float(np.sqrt((y[s : s + rms_win] ** 2).mean()))

    start_min = crossfade
    start_max = max(start_min + 1, len(y) - min_loop - 1)
    best: LoopResult | None = None

    for si in range(start_candidates):
        start = int(start_min + si / max(1, start_candidates - 1) * (start_max - start_min))
        spec_s = _spectrum(y, start)
        mfcc_s = _mfcc_at(y, sr, start)
        rms_s = rms_at(start)

        for li in range(length_candidates):
            length = int(min_loop + li / max(1, length_candidates - 1) * (max_loop - min_loop))
            end = start + length
            if end + 128 >= len(y):
                continue

            w = 128
            a = y[start : start + w]
            b = y[end : end + w]
            energy = float(np.abs(a).sum() + np.abs(b).sum())
            w_dist = float(np.abs(a - b).sum()) / energy if energy > 0 else 0.0

            rms_e = rms_at(end)
            rms_diff = abs(rms_s - rms_e) / (rms_s + rms_e) if rms_s + rms_e > 0 else 0.0

            spec_e = _spectrum(y, end)
            num = float(((spec_s - spec_e) ** 2).sum())
            den = float((spec_s**2).sum() + (spec_e**2).sum())
            s_dist = float(np.sqrt(num / den)) if den > 0 else 0.0

            mfcc_e = _mfcc_at(y, sr, end)
            m_dist = float(np.linalg.norm(mfcc_s - mfcc_e) / (np.linalg.norm(mfcc_s) + np.linalg.norm(mfcc_e) + 1e-9))
            s_dist = 0.6 * s_dist + 0.4 * m_dist

            penalty = 0.0
            for c in (start, end):
                wi = c // env_win
                lo, hi = max(0, wi - 2), min(len(env), wi + 3)
                if len(env[lo:hi]) and (env[lo:hi] > env_mean * 2).any():
                    penalty += 0.5
            penalty = min(1.0, penalty)

            score = w_dist * 0.4 + rms_diff * 0.2 + s_dist * 0.3 + penalty * 0.1
            if best is None or score < best.score:
                best = LoopResult(start, end, crossfade_ms, score)

    return best


def render_loop(y: np.ndarray, sr: int, loop: LoopResult) -> np.ndarray:
    """equal-power crossfade で末尾を loop start 直前の音へ繋ぐ。"""
    length = loop.end - loop.start
    out = y[loop.start : loop.end].copy()
    cf = min(int(loop.crossfade_ms / 1000 * sr), loop.start, length // 2)
    if cf <= 0:
        return out
    t = (np.arange(cf) + 1) / (cf + 1)
    gain_a = np.cos(t * np.pi / 2)
    gain_b = np.sin(t * np.pi / 2)
    pre = y[loop.start - cf : loop.start]
    out[length - cf :] = out[length - cf :] * gain_a + pre * gain_b
    return out.astype(np.float32)
