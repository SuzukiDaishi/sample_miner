"""採掘・キュレーション済み素材から 16 小節トラックを自動組み立てする。

素材はすべて同一曲由来なので、曲の検出 BPM / Key に合わせて組むと馴染む。
- drums: kick/snare/hat (帯域比で最適素材を選択)
- bass: bass one-shot を進行のルートへ pitch shift
- pad: 抽出 wavetable (.zwt) を band-limit してコード演奏
- vocal: フレーズを小節頭に配置 + 短い chop をアクセントに
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 48000

KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR = [0, 2, 4, 5, 7, 9, 11]
MINOR = [0, 2, 3, 5, 7, 8, 10]


def db_gain(v: float) -> float:
    return 10 ** (v / 20)


def load_mono(path: Path) -> np.ndarray:
    data, sr = sf.read(path, always_2d=True, dtype="float32")
    y = data.mean(axis=1).astype(np.float32)
    if sr != SR:
        import librosa

        y = librosa.resample(y, orig_sr=sr, target_sr=SR)
    return y


def pitch_shift(y: np.ndarray, semis: float) -> np.ndarray:
    """resample 方式 (長さも変わる)。one-shot 用。"""
    ratio = 2 ** (semis / 12)
    n = max(8, int(len(y) / ratio))
    idx = np.arange(n) * ratio
    return np.interp(idx, np.arange(len(y)), y).astype(np.float32)


def parse_key(key: str | None) -> tuple[int, list[int], bool]:
    """'Dmaj' → (root_pc, scale, is_major)。不明なら Am。"""
    if key:
        for i, n in sorted(enumerate(KEY_NAMES), key=lambda x: -len(x[1])):
            if key.startswith(n):
                is_major = "maj" in key
                return i, (MAJOR if is_major else MINOR), is_major
    return 9, MINOR, False


# ---- wavetable pad ----

def load_wavetable(wt_dir: Path) -> np.ndarray | None:
    if not wt_dir.exists():
        return None
    for j in sorted(wt_dir.glob("*.zwt.json")):
        meta = json.loads(j.read_text(encoding="utf-8"))
        bin_path = j.parent / meta["binaryPath"]
        if not bin_path.exists():
            continue
        raw = np.frombuffer(bin_path.read_bytes(), dtype="<f4")
        return raw.reshape(meta["frames"], meta["frameLen"]).copy()
    return None


def bandlimit(frames: np.ndarray, max_harm: int) -> np.ndarray:
    out = np.zeros_like(frames)
    for i, fr in enumerate(frames):
        spec = np.fft.rfft(fr)
        spec[0] = 0
        spec[max_harm + 1 :] = 0
        out[i] = np.fft.irfft(spec, n=len(fr))
    peak = np.abs(out).max() or 1.0
    return (out / peak).astype(np.float32)


def wt_note(frames_bl: np.ndarray, midi: int, dur: float) -> np.ndarray:
    f = 440 * 2 ** ((midi - 69) / 12)
    n = int(dur * SR)
    fl = frames_bl.shape[1]
    phase = (np.cumsum(np.full(n, f / SR)) % 1.0) * fl
    i0 = phase.astype(np.int64) % fl
    i1 = (i0 + 1) % fl
    frac = (phase - np.floor(phase)).astype(np.float32)

    wtpos = np.linspace(0.0, frames_bl.shape[0] - 1.001, n)
    w0 = wtpos.astype(np.int64)
    w1 = np.minimum(w0 + 1, frames_bl.shape[0] - 1)
    wfrac = (wtpos - w0).astype(np.float32)

    a = frames_bl[w0, i0] * (1 - frac) + frames_bl[w0, i1] * frac
    b = frames_bl[w1, i0] * (1 - frac) + frames_bl[w1, i1] * frac
    y = a * (1 - wfrac) + b * wfrac

    atk = min(n // 3, int(0.6 * SR))
    rel = min(n // 3, int(0.8 * SR))
    env = np.ones(n, dtype=np.float32)
    env[:atk] = np.linspace(0, 1, atk)
    env[-rel:] *= np.linspace(1, 0, rel)
    return (y * env).astype(np.float32)


# ---- arrangement ----

def place(buf: np.ndarray, y: np.ndarray, at_sec: float, gain_db: float = 0.0) -> None:
    i = int(at_sec * SR)
    if i >= len(buf):
        return
    seg = y * db_gain(gain_db)
    end = min(len(buf), i + len(seg))
    buf[i:end] += seg[: end - i]


def band_ratios(y: np.ndarray) -> tuple[float, float]:
    n = min(len(y), SR)
    spec = np.abs(np.fft.rfft(y[:n] * np.hanning(n))) ** 2
    freqs = np.fft.rfftfreq(n, 1 / SR)
    total = spec.sum() + 1e-12
    return (
        float(spec[freqs < 150].sum() / total),
        float(spec[freqs > 5000].sum() / total),
    )


def best_drum(files: list[Path], kind: str) -> tuple[np.ndarray, Path] | None:
    """kick=低域比 / hat=高域比 / snare=中域比 が最大の素材を選ぶ。"""
    scored = []
    for p in files:
        y = load_mono(p)
        low, high = band_ratios(y)
        s = low if kind == "kick" else high if kind == "hat" else 1 - low - high
        scored.append((s, p, y))
    if not scored:
        return None
    scored.sort(key=lambda x: -x[0])
    return scored[0][2], scored[0][1]


def build_track(
    project_dir: Path,
    curated_dir: Path,
    out_dir: Path,
    bars: int = 16,
    seed: int = 0,
) -> dict:
    rng = np.random.default_rng(seed)
    manifest = json.loads((project_dir / "manifest.json").read_text(encoding="utf-8"))
    bpm = None
    key = None
    for a in manifest["assets"]:
        bpm = bpm or a.get("bpm")
        key = key or a.get("key")
    bpm = float(bpm or 120)
    while bpm < 85:
        bpm *= 2
    while bpm > 180:
        bpm /= 2

    root_pc, scale, is_major = parse_key(key)

    def wavs(sub: str) -> list[Path]:
        d = curated_dir / sub
        return sorted(d.glob("*.wav")) if d.exists() else []

    kicks, snares, hats = wavs("drums_kick"), wavs("drums_snare"), wavs("drums_hat")
    basses = wavs("bass") or wavs("melodic")
    # typed BassOneShot (bass_bass_*) を最優先 (root note の信頼度が高い)
    basses.sort(key=lambda p: (0 if p.stem.startswith("bass_bass") else 1, p.name))
    vocals = sorted(wavs("vocal_phrases"), key=lambda p: -p.stat().st_size)
    drones = wavs("drones")
    frames = load_wavetable(curated_dir / "wavetables")

    spb = 60 / bpm
    bar = 4 * spb
    total = bars * bar + 3.0
    n = int(total * SR)

    stems = {
        name: np.zeros(n, dtype=np.float32)
        for name in ("drums", "bass", "pad", "vocal", "fx")
    }

    kick_sel = best_drum(kicks, "kick")
    snare_sel = best_drum(snares, "snare")
    hat_sel = best_drum(hats, "hat")
    kick = kick_sel[0] if kick_sel else None
    snare = snare_sel[0] if snare_sel else None
    hat = hat_sel[0] if hat_sel else None
    bass_y = load_mono(basses[0]) if basses else None
    bass_root = 45
    if basses:
        stem_name = basses[0].stem
        for a in manifest["assets"]:
            if (
                a.get("renderedPath")
                and Path(a["renderedPath"]).stem == stem_name
                and a.get("rootMidi")
            ):
                bass_root = a["rootMidi"]
                break

    degrees = [0, 4, 5, 3] if is_major else [0, 5, 2, 6]

    def degree_midi(deg: int, base: int) -> int:
        pc = (root_pc + scale[deg % 7]) % 12
        return base + ((pc - base) % 12)

    frames_bl = bandlimit(frames, 45) if frames is not None else None

    def section(b: int) -> str:
        if b < 2:
            return "intro"
        if b < 4:
            return "build"
        if b < 12:
            return "main"
        if b < 14:
            return "break"
        return "main"

    for b in range(bars):
        t0 = b * bar
        sec = section(b)
        deg = degrees[b % 4]

        if sec in ("build", "main") and kick is not None:
            beats = [0, 1, 2, 3] if sec == "main" else [0, 2]
            for beat in beats:
                place(stems["drums"], kick, t0 + beat * spb, 1.5)
        if sec == "main" and snare is not None:
            for beat in (1, 3):
                place(stems["drums"], snare, t0 + beat * spb, -2.5)
        if sec in ("build", "main") and hat is not None:
            for e in range(8):
                if rng.random() < 0.92:
                    g = -6 if e % 2 == 0 else -10
                    place(stems["drums"], hat, t0 + e * 0.5 * spb, g)
        if sec == "main" and b % 4 == 3 and snare is not None:
            for e, g in ((3.25, -8), (3.5, -6), (3.75, -4)):
                place(stems["drums"], snare, t0 + e * spb, g)

        if sec in ("build", "main") and bass_y is not None:
            root_midi = degree_midi(deg, 38)
            fifth_midi = root_midi + 7
            pattern = [
                (0, root_midi, 0.9),
                (1, root_midi, 0.45),
                (1.5, root_midi, 0.45),
                (2, root_midi, 0.9),
                (3, root_midi, 0.45),
                (3.5, fifth_midi, 0.45),
            ]
            for beat, midi, note_len in pattern:
                yb = pitch_shift(bass_y, midi - bass_root)
                max_len = int(note_len * spb * SR)
                if len(yb) > max_len:
                    yb = yb[:max_len].copy()
                    yb[-240:] *= np.linspace(1, 0, 240)
                place(stems["bass"], yb, t0 + beat * spb, -1)

        if frames_bl is not None:
            triad = [degree_midi(deg, 57)]
            for step in (2, 4):
                interval = scale[(deg + step) % 7] - scale[deg % 7]
                if interval < 0:
                    interval += 12
                triad.append(triad[0] + interval)
            gain = -13 if sec == "main" else -10
            for m in triad:
                place(stems["pad"], wt_note(frames_bl, m, bar * 1.05), t0, gain)

        if drones and sec in ("intro", "break"):
            dr = load_mono(drones[0])
            need = int(bar * SR)
            if len(dr) < need:
                dr = np.tile(dr, int(np.ceil(need / len(dr))))
            place(stems["fx"], dr[:need] * np.linspace(1, 0.6, need), t0, -16)

    if vocals:
        v1 = load_mono(vocals[0])
        place(stems["vocal"], v1, 0 * bar, -3)
        if len(vocals) > 1:
            place(stems["vocal"], load_mono(vocals[1]), 12 * bar, -3)
        chops = [p for p in vocals if p.stat().st_size < SR * 2 * 2] or vocals
        chop = load_mono(chops[-1])
        chop = chop[: int(0.6 * spb * SR)].copy()
        if len(chop) > 480:
            chop[-480:] *= np.linspace(1, 0, 480)
        for b in (5, 7, 9, 11, 14):
            place(stems["vocal"], chop, b * bar + 3.5 * spb, -7)

    # ---- mix & master ----
    mix = sum(stems.values())
    drive = 1.4
    mix = np.tanh(mix * drive) / np.tanh(drive)
    peak = float(np.abs(mix).max()) or 1.0
    mix *= db_gain(-1) / peak

    out_dir.mkdir(parents=True, exist_ok=True)
    sf.write(out_dir / "mix.wav", mix, SR, subtype="PCM_16")
    (out_dir / "stems").mkdir(exist_ok=True)
    for name, buf in stems.items():
        if float(np.abs(buf).max()) > 1e-5:
            bnorm = buf / (float(np.abs(buf).max()) or 1.0) * db_gain(-1)
            sf.write(out_dir / "stems" / f"{name}.wav", bnorm, SR, subtype="PCM_16")

    # ---- QC ----
    head = mix[: SR * 30] if len(mix) > SR * 30 else mix
    rms = float(np.sqrt((mix**2).mean()))
    spec = np.abs(np.fft.rfft(head)) ** 2
    freqs = np.fft.rfftfreq(len(head), 1 / SR)
    total_e = spec.sum() + 1e-12
    qc = {
        "bpm": round(bpm, 1),
        "key": key,
        "bars": bars,
        "seed": seed,
        "durationSec": round(total, 1),
        "peakDb": round(20 * np.log10(float(np.abs(mix).max())), 1),
        "rmsDb": round(20 * np.log10(rms), 1),
        "crest": round(float(np.abs(mix).max()) / (rms + 1e-9), 1),
        "lowRatio": round(float(spec[freqs < 120].sum() / total_e), 2),
        "highRatio": round(float(spec[freqs > 6000].sum() / total_e), 2),
        "materials": {
            "kick": kick_sel[1].name if kick_sel else None,
            "snare": snare_sel[1].name if snare_sel else None,
            "hat": hat_sel[1].name if hat_sel else None,
            "bass": basses[0].name if basses else None,
            "vocals": [v.name for v in vocals[:2]],
            "wavetablePad": frames is not None,
            "drone": drones[0].name if drones else None,
        },
    }
    (out_dir / "track_info.json").write_text(
        json.dumps(qc, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return qc
