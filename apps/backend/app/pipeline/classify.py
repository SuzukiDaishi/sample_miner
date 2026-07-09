"""分類: ルールベース大分類 + stem ヒント。docs 03 §6 / docs 07 §6 の方針
(AI は決定ではなく候補提示 — CLAP タグは features["clapTags"] に付くだけ)。
"""
from __future__ import annotations

SILENCE_PEAK_DB = -55.0


def classify(features: dict, stem: str | None = None) -> str:
    dur = features.get("durationSec", 0.0)
    peak = features.get("peakDb", -100.0)
    attack = features.get("attackMs", 999.0)
    conf = features.get("f0Confidence") or 0.0
    stab = features.get("f0StabilityCents")
    stab = 999.0 if stab is None else stab
    voiced = features.get("voicedRatio") or 0.0
    flat = features.get("spectralFlatnessMean") or 0.0
    td = features.get("transientDensity") or 0.0

    if peak < SILENCE_PEAK_DB:
        return "Reject"

    # stem ヒント (docs 01 §2: drums→percussive, bass→bass, vocals→vocal chop)
    # 注: pyin の confidence (voiced_prob 平均) は実楽曲で 0.3〜0.45 程度に
    # 留まるため、Web Lite (YIN) より閾値を下げてある。
    if stem == "drums" and dur < 1.5:
        return "PercussiveOneShot"
    if stem == "vocals":
        return "VocalChop" if dur < 2.0 else "MelodicPhrase"
    if stem == "bass" and conf > 0.25 and voiced > 0.6 and dur < 2.5:
        return "BassOneShot"

    if dur < 1.2 and attack < 35 and conf < 0.25:
        return "PercussiveOneShot"

    if dur > 0.15 and conf > 0.35 and stab < 20 and voiced > 0.6:
        return "WavetableCandidate"

    if dur < 2.5 and conf > 0.3 and stab < 25 and voiced > 0.5:
        return "MelodicOneShot"

    if dur > 3.0 and td < 1.0 and conf > 0.3:
        return "DroneLoop"

    if dur > 3.0 and flat > 0.45 and td < 1.0:
        return "NoiseTexture"

    if dur > 3.0 and td < 1.5 and voiced < 0.3:
        return "AmbienceLoop"

    return "MelodicPhrase"


def classification_confidence(asset_type: str, features: dict) -> float:
    conf = features.get("f0Confidence") or 0.0
    flat = features.get("spectralFlatnessMean") or 0.0
    attack = features.get("attackMs", 999.0)

    if asset_type == "Reject":
        return 0.9
    if asset_type == "PercussiveOneShot":
        fast = max(0.0, 1 - attack / 35)
        return min(0.95, 0.5 + 0.3 * fast + 0.2 * (1 - conf))
    if asset_type == "WavetableCandidate":
        return min(0.95, conf)
    if asset_type in ("MelodicOneShot", "BassOneShot"):
        return min(0.9, max(0.5, conf))
    if asset_type == "DroneLoop":
        return min(0.85, 0.4 + conf * 0.5)
    if asset_type in ("NoiseTexture", "AmbienceLoop"):
        return min(0.85, 0.4 + flat * 0.8)
    return 0.5
