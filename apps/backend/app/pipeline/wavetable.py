"""高品質 wavetable 生成 (docs 03 §7 / Phase 8)。
f0 安定区間 → 8 frame × 2048 → phase align → DC 除去 → normalize。
Web Lite 版と同一の .zwt (json + f32le) を書き出す。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import librosa
import numpy as np

FRAME_LEN = 2048
FRAMES = 8


class WavetableError(Exception):
    pass


@dataclass
class Wavetable:
    name: str
    root_midi: int
    source_pitch_hz: float
    samples: np.ndarray  # (FRAMES, FRAME_LEN) float32
    quality: dict = field(default_factory=dict)


def _phase_align(frame: np.ndarray) -> np.ndarray:
    """FFT で DC/Nyquist を除去し、基本波位相を sin 開始に揃える。"""
    spec = np.fft.rfft(frame)
    spec[0] = 0
    spec[-1] = 0
    phi = np.angle(spec[1])
    shift = phi + np.pi / 2
    k = np.arange(len(spec))
    spec *= np.exp(-1j * k * shift)
    return np.fft.irfft(spec, n=len(frame)).astype(np.float32)


def _resample_cycle(cycle: np.ndarray, dst_len: int) -> np.ndarray:
    """循環信号として線形補間 resample。"""
    n = len(cycle)
    pos = np.arange(dst_len) * (n / dst_len)
    i0 = np.floor(pos).astype(int) % n
    i1 = (i0 + 1) % n
    frac = pos - np.floor(pos)
    return (cycle[i0] * (1 - frac) + cycle[i1] * frac).astype(np.float32)


def extract_wavetable(y: np.ndarray, sr: int, name: str) -> Wavetable:
    """region から 8 frame × 2048 の wavetable を抽出する。"""
    if len(y) < 2048:
        raise WavetableError("region too short")

    f0, _voiced, voiced_prob = librosa.pyin(
        y, fmin=50, fmax=1200, sr=sr, frame_length=2048, fill_na=np.nan
    )
    hop = 512  # librosa.pyin default hop = frame_length // 4
    voiced_mask = ~np.isnan(f0)
    if voiced_mask.sum() < 4:
        raise WavetableError("pitch が検出できませんでした")

    median_f0 = float(np.median(f0[voiced_mask]))

    # 安定区間: voiced かつ median から 35 cents 以内の最長連続 run
    cents_ok = np.zeros(len(f0), dtype=bool)
    cents_ok[voiced_mask] = (
        np.abs(1200 * np.log2(f0[voiced_mask] / median_f0)) < 35
    )
    best_start = best_len = cur_start = cur_len = 0
    for i, ok in enumerate(cents_ok):
        if ok:
            if cur_len == 0:
                cur_start = i
            cur_len += 1
            if cur_len > best_len:
                best_len, best_start = cur_len, cur_start
        else:
            cur_len = 0
    if best_len < 2:
        raise WavetableError("pitch の安定した区間が短すぎます")

    start = best_start * hop
    end = min(len(y), (best_start + best_len) * hop + 2048)
    if end - start < sr / median_f0 * 6:
        raise WavetableError("pitch の安定した区間が短すぎます")

    span = end - start
    frames = np.zeros((FRAMES, FRAME_LEN), dtype=np.float32)
    conf_vals = voiced_prob[voiced_mask]

    for fi in range(FRAMES):
        t = fi / (FRAMES - 1)
        pos = int(start + t * max(0, span - 1))

        # 地点ローカル f0 (pyin frame から最寄りを取る)
        frame_idx = min(len(f0) - 1, pos // hop)
        local_f0 = f0[frame_idx] if cents_ok[frame_idx] else median_f0
        if np.isnan(local_f0):
            local_f0 = median_f0

        period = int(round(sr / float(local_f0)))
        period = max(4, period)
        cycles = 4
        need = period * cycles
        s = int(np.clip(pos - need // 2, 0, max(0, len(y) - need)))
        if len(y) - s < need:
            raise WavetableError("周期の切り出しに失敗しました")

        chunk = y[s : s + need].reshape(cycles, period)
        cycle = chunk.mean(axis=0)

        frame = _resample_cycle(cycle, FRAME_LEN)
        frame = _phase_align(frame)
        peak = float(np.abs(frame).max())
        if peak > 1e-6:
            frame /= peak
        frames[fi] = frame

    stab = float(
        np.std(1200 * np.log2(f0[cents_ok] / median_f0)) if cents_ok.sum() >= 2 else 0.0
    )
    return Wavetable(
        name=name,
        root_midi=int(round(librosa.hz_to_midi(median_f0))),
        source_pitch_hz=median_f0,
        samples=frames,
        quality={
            "pitchConfidence": float(np.mean(conf_vals)),
            "pitchStabilityCents": stab,
            "periodicity": float(np.mean(conf_vals)),
        },
    )


def write_zwt(wt: Wavetable, out_dir: Path, source_asset_id: str | None = None) -> dict:
    """docs 05 の .zwt (json + f32le) を書き出し、WavetableInfo 断片を返す。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    bin_name = f"{wt.name}.zwt.f32"
    (out_dir / bin_name).write_bytes(wt.samples.astype("<f4").tobytes())
    meta = {
        "version": 1,
        "name": wt.name,
        "frameLen": FRAME_LEN,
        "frames": FRAMES,
        "sampleFormat": "f32le",
        "rootMidi": wt.root_midi,
        "sourceAssetId": source_asset_id,
        "binaryPath": bin_name,
    }
    (out_dir / f"{wt.name}.zwt.json").write_text(
        json.dumps(meta, indent=2), encoding="utf-8"
    )
    return meta
