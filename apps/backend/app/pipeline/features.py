"""フル版特徴抽出。docs 03 §5 の AudioFeatures(MFCC / HPSS / bpm / key 含む)。
manifest schema (docs 05) に合わせて camelCase の dict を返す。
"""
from __future__ import annotations

import librosa
import numpy as np

MAX_ANALYSIS_SEC = 12.0

KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Krumhansl-Schmuckler key profiles
_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def _db(v: float) -> float:
    return float(20 * np.log10(max(v, 1e-10)))


def band_energy_ratio(y: np.ndarray, sr: int, lo_hz: float, hi_hz: float) -> float:
    """[lo_hz, hi_hz) 帯域のエネルギー比 (0..1)。スケール不変。"""
    n = len(y)
    if n < 256:
        return 0.0
    spec = np.abs(np.fft.rfft(y * np.hanning(n))) ** 2
    freqs = np.fft.rfftfreq(n, 1 / sr)
    total = float(spec.sum())
    if total <= 0:
        return 0.0
    return float(spec[(freqs >= lo_hz) & (freqs < hi_hz)].sum() / total)


def estimate_key(y: np.ndarray, sr: int) -> str | None:
    """chroma × Krumhansl profile の簡易 key 推定(track 全体用)。"""
    if len(y) < sr:
        return None
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    if chroma.max() <= 0:
        return None
    best_key, best_corr = None, -np.inf
    for shift in range(12):
        rolled = np.roll(chroma, -shift)
        for profile, suffix in ((_MAJOR, "maj"), (_MINOR, "min")):
            corr = float(np.corrcoef(rolled, profile)[0, 1])
            if corr > best_corr:
                best_corr = corr
                best_key = f"{KEY_NAMES[shift]}{suffix}"
    return best_key


def estimate_bpm(y: np.ndarray, sr: int) -> float | None:
    if len(y) < sr * 2:
        return None
    tempo = librosa.feature.tempo(y=y, sr=sr)
    return float(tempo[0]) if len(tempo) else None


def compute_features(y: np.ndarray, sr: int) -> dict:
    duration_sec = len(y) / sr
    buf = y[: int(MAX_ANALYSIS_SEC * sr)]
    if len(buf) < 64:
        return {"durationSec": duration_sec, "rmsDb": -100.0, "peakDb": -100.0}

    peak = float(np.abs(buf).max())
    rms = float(np.sqrt((buf**2).mean()))

    # attack / decay (5ms RMS envelope)
    win = max(32, int(sr * 0.005))
    n = max(1, len(buf) // win)
    env = np.sqrt((buf[: n * win].reshape(n, win) ** 2).mean(axis=1))
    peak_i = int(np.argmax(env))
    env_peak = env[peak_i]
    attack_idx = peak_i
    reach = np.nonzero(env[: peak_i + 1] >= env_peak * 0.9)[0]
    if len(reach):
        attack_idx = int(reach[0])
    attack_ms = attack_idx * win * 1000 / sr
    decay_thresh = env_peak * 10 ** (-20 / 20)
    below = np.nonzero(env[peak_i + 1 :] < decay_thresh)[0]
    decay_idx = int(below[0]) + 1 if len(below) else len(env) - 1 - peak_i
    decay_ms = decay_idx * win * 1000 / sr

    zcr = float(librosa.feature.zero_crossing_rate(buf, frame_length=1024, hop_length=512).mean())
    centroid = librosa.feature.spectral_centroid(y=buf, sr=sr, n_fft=1024, hop_length=512)[0]
    flatness = float(librosa.feature.spectral_flatness(y=buf, n_fft=1024, hop_length=512).mean())
    mfcc = librosa.feature.mfcc(y=buf, sr=sr, n_mfcc=13)

    # transient density
    onsets = librosa.onset.onset_detect(y=buf, sr=sr, hop_length=512, units="time")
    transient_density = float(len(onsets) / max(0.1, len(buf) / sr))

    # キャッチーさ代理特徴 (docs 08 §3.1)。presence/crest はスケール不変、
    # flux は loudness 退化を避けるためピーク正規化した信号で測る
    presence_ratio = band_energy_ratio(buf, sr, 2000, 5000)
    crest_db = _db(peak) - _db(rms)
    norm_buf = buf / peak if peak > 1e-6 else buf
    spectral_flux = float(
        librosa.onset.onset_strength(y=norm_buf, sr=sr, n_fft=1024, hop_length=512).mean()
    )

    # pitch (pYIN)。長い素材はコスト削減のため 22.05k へ落とす
    pitch_buf, pitch_sr = buf, sr
    if sr > 22050 and len(buf) > sr * 2:
        pitch_buf = librosa.resample(buf, orig_sr=sr, target_sr=22050)
        pitch_sr = 22050
    f0_median = None
    f0_conf = 0.0
    f0_stab = None
    voiced_ratio = 0.0
    pitch_range = None
    if len(pitch_buf) >= 2048:
        f0, voiced_flag, voiced_prob = librosa.pyin(
            pitch_buf,
            fmin=50,
            fmax=1200,
            sr=pitch_sr,
            frame_length=2048,
            fill_na=np.nan,
        )
        f0_conf = float(np.nan_to_num(voiced_prob).mean())
        voiced = f0[~np.isnan(f0)]
        if len(voiced) > 0:
            voiced_ratio = float(len(voiced) / len(f0))
            f0_median = float(np.median(voiced))
            if len(voiced) >= 2:
                cents = 1200 * np.log2(voiced / f0_median)
                f0_stab = float(np.std(cents))
                # pitch 動き量 (docs 08): octave error の影響を抑えるため
                # 10/90 percentile 幅を半音換算する
                p_lo, p_hi = np.percentile(voiced, [10, 90])
                pitch_range = float(12 * np.log2(max(p_hi, 1e-6) / max(p_lo, 1e-6)))
            else:
                f0_stab = 0.0
                pitch_range = 0.0

    # harmonic / percussive ratio (HPSS)
    harmonic_ratio = percussive_ratio = None
    if len(buf) >= 2048:
        h, p = librosa.effects.hpss(buf)
        he = float((h**2).sum())
        pe = float((p**2).sum())
        total = he + pe
        if total > 0:
            harmonic_ratio = he / total
            percussive_ratio = pe / total

    return {
        "durationSec": duration_sec,
        "rmsDb": _db(rms),
        "peakDb": _db(peak),
        "attackMs": float(attack_ms),
        "decayMs": float(decay_ms),
        "transientDensity": transient_density,
        "presenceRatio": presence_ratio,
        "crestDb": crest_db,
        "spectralFluxMean": spectral_flux,
        "pitchRangeSemitones": pitch_range,
        "spectralCentroidMean": float(centroid.mean()),
        "spectralCentroidStd": float(centroid.std()),
        "spectralFlatnessMean": flatness,
        "zeroCrossingRateMean": zcr,
        "mfccMean": [float(v) for v in mfcc.mean(axis=1)],
        "mfccStd": [float(v) for v in mfcc.std(axis=1)],
        "f0MedianHz": f0_median,
        "f0Confidence": f0_conf,
        "f0StabilityCents": f0_stab,
        "voicedRatio": voiced_ratio,
        "harmonicRatio": harmonic_ratio,
        "percussiveRatio": percussive_ratio,
    }
