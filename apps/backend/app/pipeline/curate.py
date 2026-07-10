"""素材キュレーション: 解析済みプロジェクトから素材を選定する。

品質とキャッチーさの 2 軸 (docs 08 §2):
- 品質 = 足切り: 減衰完結 / 単発性 / クリップ無し / 頭とお尻の無音着地
- キャッチーさ = カテゴリ内ランキング: presence 帯域 / crest / attack 鋭さ /
  pitch の動き / 原曲 self-similarity による hook 反復スコア
- 全出力にマイクロフェード + -1dBFS normalize
"""
from __future__ import annotations

import json
import shutil
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import soundfile as sf

from .features import band_energy_ratio
from .hooks import compute_hook_map, segment_hook_score


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
    quality: float  # 技術品質 (足切りに使用)
    catchiness: float  # キャッチーさ (カテゴリ内ランキングに使用)
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


def _lin(v: float | None, lo: float, hi: float) -> float:
    """v を [lo, hi] → [0, 1] へ線形マップ (clip)。None は 0。"""
    if v is None or hi <= lo:
        return 0.0
    return float(min(1.0, max(0.0, (v - lo) / (hi - lo))))


def crest_db(y: np.ndarray) -> float:
    return db(float(np.abs(y).max())) - rms_db(y)


# ---- キャッチーさ (docs 08 §3.1) ----
# loudness はスコアに入れない (presence/crest はスケール不変)。
# 特徴は curated 対象の音声から直接測るので旧 manifest でも動く。


def catchiness_oneshot(y: np.ndarray, sr: int, feats: dict) -> tuple[float, list[str]]:
    """drums: パンチ (crest) + 抜け (presence) + attack 鋭さ。"""
    reasons: list[str] = []
    crest = crest_db(y)
    presence = band_energy_ratio(y, sr, 2000, 5000)
    attack = feats.get("attackMs", 999.0)
    c = (
        0.4 * _lin(crest, 8, 20)
        + 0.3 * _lin(presence, 0.02, 0.35)
        + 0.3 * _lin(35 - attack, 0, 30)
    )
    if crest >= 14:
        reasons.append(f"パンチがある (crest {crest:.0f}dB)")
    if presence >= 0.15:
        reasons.append("抜けが良い (2-5kHz)")
    return c, reasons


def catchiness_bass(y: np.ndarray, sr: int, feats: dict) -> tuple[float, list[str]]:
    """bass: 低域の太さ + crest + pitch 安定。"""
    reasons: list[str] = []
    low = band_energy_ratio(y, sr, 0, 150)
    crest = crest_db(y)
    stab = feats.get("f0StabilityCents")
    stab = 999.0 if stab is None else stab
    c = (
        0.4 * _lin(low, 0.1, 0.6)
        + 0.3 * _lin(crest, 6, 18)
        + 0.3 * _lin(60 - stab, 0, 50)
    )
    if low >= 0.35:
        reasons.append("低域が太い")
    if stab < 20:
        reasons.append("pitch が安定")
    return c, reasons


def catchiness_melodic(y: np.ndarray, sr: int, feats: dict) -> tuple[float, list[str]]:
    """melodic: 抜け + pitch 明瞭 + 倍音の豊かさ + crest。"""
    reasons: list[str] = []
    presence = band_energy_ratio(y, sr, 2000, 5000)
    conf = feats.get("f0Confidence") or 0.0
    flat = feats.get("spectralFlatnessMean") or 0.0
    crest = crest_db(y)
    c = (
        0.3 * _lin(presence, 0.02, 0.3)
        + 0.3 * _lin(conf, 0.2, 0.6)
        + 0.2 * (1.0 - min(1.0, flat))
        + 0.2 * _lin(crest, 6, 18)
    )
    if presence >= 0.12:
        reasons.append("抜けが良い (2-5kHz)")
    if conf >= 0.45:
        reasons.append("pitch 明瞭")
    return c, reasons


def catchiness_phrase(y: np.ndarray, sr: int, feats: dict) -> tuple[float, list[str]]:
    """phrase/vocal: 抜け + メロディの動き + voiced 率。"""
    reasons: list[str] = []
    presence = band_energy_ratio(y, sr, 2000, 5000)
    voiced = feats.get("voicedRatio") or 0.0
    pr = feats.get("pitchRangeSemitones")
    if pr is None:
        motion = 0.3  # 測れないときは中立
    elif pr <= 7.0:
        motion = _lin(pr, 0.5, 7.0)
    else:
        # 動きすぎ (octave error 含む) は減点しつつ床を残す
        motion = max(0.3, 1.0 - (pr - 7.0) / 24.0)
    c = 0.4 * _lin(presence, 0.02, 0.3) + 0.3 * motion + 0.3 * min(1.0, voiced)
    if pr is not None and 2.0 <= pr <= 12.0:
        reasons.append(f"メロディが動く ({pr:.0f}半音)")
    if presence >= 0.12:
        reasons.append("抜けが良い (2-5kHz)")
    return c, reasons


def blend_hook(
    c: float, feats: dict, reasons: list[str], weight: float = 0.3
) -> float:
    """hook 反復スコア (docs 08 §3.2) があれば blend。無ければそのまま。"""
    hook = feats.get("hookScore")
    if hook is None:
        return c
    if hook >= 0.6:
        reasons.append(f"曲中で反復される区間 (hook {hook:.2f})")
    return (1 - weight) * c + weight * float(hook)


def blend_clap(
    c: float, feats: dict, reasons: list[str], weight: float = 0.15
) -> float:
    """CLAP 対照ペアスコア (docs 08 §3.3)。美的評価用に学習されたモデルでは
    ないため弱いシグナルとして小さい重みで blend する。決定には使わない。"""
    v = feats.get("clapCatchy")
    if v is None:
        return c
    if v >= 0.7:
        reasons.append(f"CLAP 対照スコア高 ({v:.2f})")
    return (1 - weight) * c + weight * float(v)


def catchiness_for_asset(
    y: np.ndarray, sr: int, feats: dict, asset_type: str
) -> tuple[float, list[str]]:
    """asset type に応じたキャッチーさ (hook / CLAP blend 込み)。

    curate の選定と runner の CLAP 対象選定 (docs 08 §3.3) の共通入口。
    """
    if asset_type in ("PercussiveOneShot", "Impact"):
        c, reasons = catchiness_oneshot(y, sr, feats)
    elif asset_type == "BassOneShot":
        c, reasons = catchiness_bass(y, sr, feats)
    elif asset_type in ("MelodicOneShot", "WavetableCandidate"):
        c, reasons = catchiness_melodic(y, sr, feats)
    elif asset_type in ("VocalChop", "MelodicPhrase", "SliceLoop"):
        c, reasons = catchiness_phrase(y, sr, feats)
        c = blend_hook(c, feats, reasons)
    else:  # DroneLoop / NoiseTexture / AmbienceLoop 等は中立
        c, reasons = 0.5, []
    return blend_clap(c, feats, reasons), reasons


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
    「音量 + ループ継ぎ目の滑らかさ + hook 反復」でスコアリングして上位を採用する。
    hook を入れないとイントロの伴奏とサビのリフが区別できない (docs 08 §3.2)。
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

    # 原曲の hook 反復マップ (旧 manifest でも動くようここで計算する)
    try:
        hook_map = compute_hook_map(gy, g_sr)
    except Exception:
        hook_map = None

    candidates: list[tuple[float, float, float | None, int, int, int, int]] = []
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
            base = min(1.0, (level + 28) / 20) * 0.6 + max(0.0, 1 - seam) * 0.4
            hook = (
                segment_hook_score(hook_map, s / o_sr, e / o_sr)
                if hook_map is not None
                else None
            )
            score = 0.6 * base + 0.4 * hook if hook is not None else base
            candidates.append((score, seam, hook, bi, nbars, s, e))

    candidates.sort(key=lambda c: -c[0])
    results: list[Curated] = []
    used_bars: set[int] = set()
    for score, seam, hook, bi, nbars, s, e in candidates:
        if len(results) >= max_riffs:
            break
        if any(b in used_bars for b in range(bi, bi + nbars)):
            continue
        used_bars.update(range(bi, bi + nbars))
        rel = f"riffs/other_riff_{len(results) + 1:02d}_{nbars}bar.wav"
        export_wav(oy[s:e], o_sr, out_dir / rel, 3, 15)
        reasons = [f"{nbars}小節 beat-aligned 切り出し", f"継ぎ目スコア {1 - seam:.2f}"]
        if hook is not None and hook >= 0.6:
            reasons.append(f"曲中で反復される区間 (hook {hook:.2f})")
        results.append(
            Curated(
                project_dir / other["wavPath"],
                rel,
                "riffs",
                (e - s) / o_sr,
                None,
                quality=max(0.0, 1 - seam),
                catchiness=score,
                reasons=reasons,
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
            quality, reasons, complete = analyze_oneshot(y, sr, feats)
            # bass ステム由来のパーカッシブはベースのプラック → bass 素材へ
            if base.startswith("bass_"):
                if a.get("rootMidi") is None or quality < 0.5:
                    continue
                catchy, c_reasons = catchiness_for_asset(y, sr, feats, "BassOneShot")
                rel = f"bass/{base}.wav"
                export_wav(y, sr, out_dir / rel, 1, 8 if complete else 60)
                results.append(
                    Curated(path, rel, "bass", dur, a.get("rootNote"), quality,
                            catchy, reasons + c_reasons + ["bass ステム由来"])
                )
                continue
            if quality < 0.6 or not complete:
                continue
            if not base.startswith("drums_"):
                quality -= 0.15
            role = drum_role(y, sr)
            catchy, c_reasons = catchiness_for_asset(y, sr, feats, t)
            rel = f"drums_{role}/{base}.wav"
            export_wav(y, sr, out_dir / rel, 1, 6)
            results.append(
                Curated(path, rel, f"drums_{role}", dur, None, quality, catchy,
                        reasons + c_reasons)
            )

        elif t in ("BassOneShot", "MelodicOneShot", "WavetableCandidate"):
            quality, reasons, complete = analyze_oneshot(y, sr, feats)
            if (feats.get("f0Confidence") or 0) < 0.2:
                continue
            if quality < 0.5:
                continue
            fade_out = 8 if complete else 60
            folder = "bass" if t == "BassOneShot" else "melodic"
            catchy, c_reasons = catchiness_for_asset(y, sr, feats, t)
            rel = f"{folder}/{base}.wav"
            export_wav(y, sr, out_dir / rel, 1, fade_out)
            results.append(
                Curated(path, rel, folder, dur, a.get("rootNote"), quality, catchy,
                        reasons + c_reasons)
            )

        elif t in ("VocalChop", "MelodicPhrase", "SliceLoop"):
            quality, reasons = analyze_phrase(y, sr)

            # other ステムのフレーズは曲 BPM の小節長へトリムして riff loop 化。
            # ループ用途なので「語尾の無音着地」は要求しない。
            if base.startswith("other_") and bpm:
                bar_sec = 4 * 60.0 / float(bpm)
                mult = next((m for m in (4, 2, 1, 0.5) if dur >= m * bar_sec * 0.97), None)
                if mult is not None:
                    target = int(round(mult * bar_sec * sr))
                    if 0 < target <= len(y) and rms_db(y[:target]) > -28:
                        riff_quality = 0.5 + (0.1 if mult >= 1 else 0.0) + min(0.2, quality * 0.3)
                        riff_reasons = [f"{mult}小節ループ化 ({bpm:.0f}BPM)"]
                        # riff は hook 反復が主軸 (docs 08 §3.2)
                        riff_catchy = blend_hook(riff_quality, feats, riff_reasons, weight=0.4)
                        riff_catchy = blend_clap(riff_catchy, feats, riff_reasons)
                        mult_tag = str(mult).replace(".", "_")
                        rel_riff = f"riffs/{base}_loop{mult_tag}bar.wav"
                        export_wav(y[:target], sr, out_dir / rel_riff, 3, 25)
                        results.append(
                            Curated(path, rel_riff, "riffs", target / sr,
                                    a.get("rootNote"), riff_quality, riff_catchy,
                                    riff_reasons)
                        )

            if quality < 0.55:
                continue
            catchy, c_reasons = catchiness_for_asset(y, sr, feats, t)
            folder = "vocal_phrases" if "vocal" in base else "phrases"
            rel = f"{folder}/{base}.wav"
            export_wav(y, sr, out_dir / rel, 8, 60)
            results.append(
                Curated(path, rel, folder, dur, a.get("rootNote"), quality, catchy,
                        reasons + c_reasons)
            )

        elif t in ("DroneLoop", "NoiseTexture", "AmbienceLoop"):
            rel = f"drones/{base}.wav"
            export_wav(y, sr, out_dir / rel, 20, 20)
            results.append(
                Curated(path, rel, "drones", dur, None, 0.6, 0.5, ["loop 素材"])
            )

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

    # カテゴリごとに上位のみ残す。品質は足切り済みなので、
    # 順位はキャッチーさで決める (同点は品質で tie-break)
    kept: list[Curated] = []
    for cat, cap in CATEGORY_CAPS.items():
        group = sorted(
            (r for r in results if r.category == cat),
            key=lambda r: (-r.catchiness, -r.quality),
        )
        for r in group[cap:]:
            (out_dir / r.out_rel).unlink(missing_ok=True)
        kept.extend(group[:cap])
    return kept
