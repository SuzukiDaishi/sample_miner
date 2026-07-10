"""素材キュレーション: 解析済みプロジェクトから品質検証済み素材を選定する。

- one-shot: 減衰完結(末尾 25ms が peak-28dB 以下)/ 単発性 / attack / クリップ
- 声・フレーズ: 頭とお尻が無音に着地(途中で切れていない)
- 全出力にマイクロフェード + -1dBFS normalize
"""
from __future__ import annotations

import json
import shutil
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import soundfile as sf


def db(v: float) -> float:
    return float(20 * np.log10(max(v, 1e-10)))


def rms_db(y: np.ndarray) -> float:
    if len(y) == 0:
        return -100.0
    return db(float(np.sqrt((y**2).mean())))


@dataclass
class Curated:
    src: Path
    out_rel: str  # 出力ディレクトリ内の相対パス
    category: str
    duration: float
    note: str | None
    score: float
    reasons: list[str] = field(default_factory=list)


CATEGORY_CAPS = {
    "drums_kick": 6,
    "drums_snare": 6,
    "drums_hat": 6,
    "bass": 8,
    "melodic": 8,
    "vocal_phrases": 12,
    "phrases": 8,
    "riffs": 8,
    "drones": 4,
}


def analyze_oneshot(
    y: np.ndarray, sr: int, feats: dict
) -> tuple[float, list[str], bool]:
    """one-shot 品質: (score, reasons, decay_complete)"""
    reasons: list[str] = []
    score = 0.0

    peak_d = db(float(np.abs(y).max()))
    if peak_d < -30:
        return 0.0, ["音量不足"], False

    tail = rms_db(y[-int(0.025 * sr) :])
    decay_complete = (peak_d - tail) >= 28
    if decay_complete:
        score += 0.35
        reasons.append("減衰が最後まで収録")
    else:
        reasons.append(f"末尾で切れている (peak-{peak_d - tail:.0f}dB)")

    attack = feats.get("attackMs", 999)
    if attack < 20:
        score += 0.25
        reasons.append(f"attack {attack:.0f}ms")
    elif attack < 40:
        score += 0.15

    td = feats.get("transientDensity") or 0
    dur = len(y) / sr
    if td * dur <= 2.0:
        score += 0.2
        reasons.append("単発")
    else:
        reasons.append(f"複数打 ({td * dur:.0f})")

    clip = int((np.abs(y) >= 0.999).sum())
    if clip == 0:
        score += 0.1
    else:
        reasons.append(f"clip {clip}sample")

    if 0.08 <= dur <= 2.0:
        score += 0.1

    return score, reasons, decay_complete


def analyze_phrase(y: np.ndarray, sr: int) -> tuple[float, list[str]]:
    """長尺・声素材: 端の着地と長さで評価。"""
    reasons: list[str] = []
    score = 0.0
    peak_d = db(float(np.abs(y).max()))
    if peak_d < -30:
        return 0.0, ["音量不足"]

    head = rms_db(y[: int(0.02 * sr)])
    tail = rms_db(y[-int(0.04 * sr) :])
    if peak_d - head >= 20:
        score += 0.25
        reasons.append("頭が無音から始まる")
    if peak_d - tail >= 22:
        score += 0.35
        reasons.append("語尾が無音に着地")
    else:
        reasons.append("語尾が切れ気味")

    dur = len(y) / sr
    if dur >= 1.0:
        score += 0.25
        reasons.append(f"{dur:.1f}s")
    elif dur >= 0.4:
        score += 0.15
    if int((np.abs(y) >= 0.999).sum()) == 0:
        score += 0.15
    return score, reasons


def drum_role(y: np.ndarray, sr: int) -> str:
    """kick / snare / hat を帯域エネルギーで振り分け。"""
    n = min(len(y), sr)
    spec = np.abs(np.fft.rfft(y[:n] * np.hanning(n))) ** 2
    freqs = np.fft.rfftfreq(n, 1 / sr)
    total = spec.sum() + 1e-12
    low = spec[freqs < 150].sum() / total
    high = spec[freqs > 5000].sum() / total
    if low > 0.35:
        return "kick"
    if high > 0.35:
        return "hat"
    return "snare"


def export_wav(
    y: np.ndarray, sr: int, out: Path, fade_in_ms: float, fade_out_ms: float
) -> None:
    """マイクロフェード + -1dBFS normalize で書き出し。"""
    y = y.copy()
    fi = min(len(y) // 4, int(fade_in_ms / 1000 * sr))
    fo = min(len(y) // 2, int(fade_out_ms / 1000 * sr))
    if fi > 0:
        y[:fi] *= np.linspace(0, 1, fi)
    if fo > 0:
        y[-fo:] *= np.linspace(1, 0, fo)
    peak = float(np.abs(y).max())
    if peak > 1e-6:
        y *= 10 ** (-1 / 20) / peak
    out.parent.mkdir(parents=True, exist_ok=True)
    sf.write(out, y, sr, subtype="PCM_16")


def extract_other_riffs(
    project_dir: Path, manifest: dict, out_dir: Path, max_riffs: int = 8
) -> list[Curated]:
    """DemucsOther ステムから beat-aligned な riff loop を直接切り出す。

    密度の高い曲では onset チョップが細切れになり riff が採れないため、
    原曲の beat tracking で小節グリッドを求め、1〜2 小節窓を
    「音量 + ループ継ぎ目の滑らかさ」でスコアリングして上位を採用する。
    """
    import librosa

    tracks = {t["kind"]: t for t in manifest.get("derivedTracks", []) if t.get("wavPath")}
    other = tracks.get("DemucsOther")
    orig = tracks.get("Original")
    if other is None or orig is None:
        return []

    o_data, o_sr = sf.read(project_dir / other["wavPath"], always_2d=True, dtype="float32")
    oy = o_data.mean(axis=1).astype(np.float32)
    g_data, g_sr = sf.read(project_dir / orig["wavPath"], always_2d=True, dtype="float32")
    gy = g_data.mean(axis=1).astype(np.float32)
    if o_sr != g_sr or len(oy) < o_sr * 8:
        return []

    _tempo, beats = librosa.beat.beat_track(y=gy, sr=g_sr, units="samples")
    if len(beats) < 12:
        return []
    bar_starts = [int(b) for b in beats[::4]]

    candidates: list[tuple[float, float, int, int, int, int]] = []
    for bi in range(len(bar_starts) - 1):
        for nbars in (1, 2):
            if bi + nbars >= len(bar_starts):
                continue
            s, e = bar_starts[bi], bar_starts[bi + nbars]
            if e - s < o_sr // 2 or e > len(oy):
                continue
            seg = oy[s:e]
            level = rms_db(seg)
            if level < -28:
                continue
            # ループ継ぎ目: 先頭と末尾の波形が近いほど滑らかに回る
            w = 256
            head, tail = seg[:w], seg[-w:]
            energy = float(np.abs(head).sum() + np.abs(tail).sum())
            seam = float(np.abs(head - tail).sum()) / energy if energy > 0 else 1.0
            score = min(1.0, (level + 28) / 20) * 0.6 + max(0.0, 1 - seam) * 0.4
            candidates.append((score, seam, bi, nbars, s, e))

    candidates.sort(key=lambda c: -c[0])
    results: list[Curated] = []
    used_bars: set[int] = set()
    for score, seam, bi, nbars, s, e in candidates:
        if len(results) >= max_riffs:
            break
        if any(b in used_bars for b in range(bi, bi + nbars)):
            continue
        used_bars.update(range(bi, bi + nbars))
        rel = f"riffs/other_riff_{len(results) + 1:02d}_{nbars}bar.wav"
        export_wav(oy[s:e], o_sr, out_dir / rel, 3, 15)
        results.append(
            Curated(
                project_dir / other["wavPath"],
                rel,
                "riffs",
                (e - s) / o_sr,
                None,
                score,
                [f"{nbars}小節 beat-aligned 切り出し", f"継ぎ目スコア {1 - seam:.2f}"],
            )
        )
    return results


def curate_project(project_dir: Path, out_dir: Path) -> list[Curated]:
    """manifest 済みプロジェクトの素材を選定し out_dir/<category>/ へ書き出す。"""
    manifest = json.loads((project_dir / "manifest.json").read_text(encoding="utf-8"))
    seg_by_id = {s["id"]: s for s in manifest["segments"]}
    bpm = next((a.get("bpm") for a in manifest["assets"] if a.get("bpm")), None)
    results: list[Curated] = []

    for a in manifest["assets"]:
        if not a.get("renderedPath"):
            continue
        path = project_dir / a["renderedPath"]
        if not path.exists():
            continue
        data, sr = sf.read(path, always_2d=True, dtype="float32")
        y = data.mean(axis=1).astype(np.float32)
        feats = seg_by_id[a["segmentId"]]["features"]
        dur = len(y) / sr
        t = a["type"]
        base = Path(a["renderedPath"]).stem

        if t in ("PercussiveOneShot", "Impact"):
            score, reasons, complete = analyze_oneshot(y, sr, feats)
            # bass ステム由来のパーカッシブはベースのプラック → bass 素材へ
            if base.startswith("bass_"):
                if a.get("rootMidi") is None or score < 0.5:
                    continue
                rel = f"bass/{base}.wav"
                export_wav(y, sr, out_dir / rel, 1, 8 if complete else 60)
                results.append(
                    Curated(path, rel, "bass", dur, a.get("rootNote"), score,
                            reasons + ["bass ステム由来"])
                )
                continue
            if score < 0.6 or not complete:
                continue
            if not base.startswith("drums_"):
                score -= 0.15
            role = drum_role(y, sr)
            rel = f"drums_{role}/{base}.wav"
            export_wav(y, sr, out_dir / rel, 1, 6)
            results.append(Curated(path, rel, f"drums_{role}", dur, None, score, reasons))

        elif t in ("BassOneShot", "MelodicOneShot", "WavetableCandidate"):
            score, reasons, complete = analyze_oneshot(y, sr, feats)
            if (feats.get("f0Confidence") or 0) < 0.2:
                continue
            if score < 0.5:
                continue
            fade_out = 8 if complete else 60
            folder = "bass" if t == "BassOneShot" else "melodic"
            if t == "BassOneShot":
                score += 0.2
                reasons.append("pitch 信頼度高")
            rel = f"{folder}/{base}.wav"
            export_wav(y, sr, out_dir / rel, 1, fade_out)
            results.append(Curated(path, rel, folder, dur, a.get("rootNote"), score, reasons))

        elif t in ("VocalChop", "MelodicPhrase", "SliceLoop"):
            score, reasons = analyze_phrase(y, sr)

            # other ステムのフレーズは曲 BPM の小節長へトリムして riff loop 化。
            # ループ用途なので「語尾の無音着地」は要求しない。
            if base.startswith("other_") and bpm:
                bar_sec = 4 * 60.0 / float(bpm)
                mult = next((m for m in (4, 2, 1, 0.5) if dur >= m * bar_sec * 0.97), None)
                if mult is not None:
                    target = int(round(mult * bar_sec * sr))
                    if 0 < target <= len(y) and rms_db(y[:target]) > -28:
                        riff_score = 0.5 + (0.1 if mult >= 1 else 0.0) + min(0.2, score * 0.3)
                        mult_tag = str(mult).replace(".", "_")
                        rel_riff = f"riffs/{base}_loop{mult_tag}bar.wav"
                        export_wav(y[:target], sr, out_dir / rel_riff, 3, 25)
                        results.append(
                            Curated(path, rel_riff, "riffs", target / sr,
                                    a.get("rootNote"), riff_score,
                                    [f"{mult}小節ループ化 ({bpm:.0f}BPM)"])
                        )

            if score < 0.55:
                continue
            folder = "vocal_phrases" if "vocal" in base else "phrases"
            rel = f"{folder}/{base}.wav"
            export_wav(y, sr, out_dir / rel, 8, 60)
            results.append(Curated(path, rel, folder, dur, a.get("rootNote"), score, reasons))

        elif t in ("DroneLoop", "NoiseTexture", "AmbienceLoop"):
            rel = f"drones/{base}.wav"
            export_wav(y, sr, out_dir / rel, 20, 20)
            results.append(Curated(path, rel, "drones", dur, None, 0.6, ["loop 素材"]))

    # DemucsOther から beat-aligned riff を直接切り出す
    # (onset チョップが細切れになる曲でも riff を確保する)
    try:
        results.extend(extract_other_riffs(project_dir, manifest, out_dir))
    except Exception:
        pass  # riff 抽出は補助機能なので失敗しても他の素材選定は続行

    # wavetable (.zwt) はそのままコピー
    wt_dir = project_dir / "wavetables"
    if wt_dir.exists():
        for f in wt_dir.iterdir():
            dest = out_dir / "wavetables" / f.name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, dest)

    # カテゴリごとに上位のみ残す
    kept: list[Curated] = []
    for cat, cap in CATEGORY_CAPS.items():
        group = sorted((r for r in results if r.category == cat), key=lambda r: -r.score)
        for r in group[cap:]:
            (out_dir / r.out_rel).unlink(missing_ok=True)
        kept.extend(group[:cap])
    return kept
