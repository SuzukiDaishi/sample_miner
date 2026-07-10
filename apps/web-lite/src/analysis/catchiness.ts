/**
 * キャッチーさスコアリング (docs 08 §3.1、backend curate.py の Layer A 移植)。
 * 品質とは直交する軸で、asset browser の並び順に使う。
 * loudness はスコアに入れない (presence/crest はスケール不変)。
 * hook 反復 (Layer B) は曲全体解析が要るため backend のみ。
 */
import type { SliceFeatures } from "./features";
import type { AssetType } from "../manifest/schema";

/** v を [lo, hi] → [0, 1] へ線形マップ (clip)。 */
function lin(v: number | undefined, lo: number, hi: number): number {
  if (v === undefined || hi <= lo) return 0;
  return Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
}

function oneshot(f: SliceFeatures): number {
  return (
    0.4 * lin(f.crestDb, 8, 20) +
    0.3 * lin(f.presenceRatio, 0.02, 0.35) +
    0.3 * lin(35 - f.attackMs, 0, 30)
  );
}

function bass(f: SliceFeatures): number {
  const stab = f.pitchStabilityCents ?? 999;
  return (
    0.4 * lin(f.lowBandRatio, 0.1, 0.6) +
    0.3 * lin(f.crestDb, 6, 18) +
    0.3 * lin(60 - stab, 0, 50)
  );
}

function melodic(f: SliceFeatures): number {
  return (
    0.3 * lin(f.presenceRatio, 0.02, 0.3) +
    0.3 * lin(f.pitchConfidence, 0.2, 0.6) +
    0.2 * (1 - Math.min(1, f.spectralFlatness)) +
    0.2 * lin(f.crestDb, 6, 18)
  );
}

function phrase(f: SliceFeatures): number {
  const pr = f.pitchRangeSemitones;
  let motion: number;
  if (pr === undefined) {
    motion = 0.3; // 測れないときは中立
  } else if (pr <= 7) {
    motion = lin(pr, 0.5, 7);
  } else {
    // 動きすぎ (octave error 含む) は減点しつつ床を残す
    motion = Math.max(0.3, 1 - (pr - 7) / 24);
  }
  return (
    0.4 * lin(f.presenceRatio, 0.02, 0.3) +
    0.3 * motion +
    0.3 * Math.min(1, f.voicedRatio ?? 0)
  );
}

/** asset type に応じたキャッチーさ 0..1。drones 等は中立 0.5。 */
export function catchinessScore(f: SliceFeatures, type: AssetType): number {
  switch (type) {
    case "PercussiveOneShot":
    case "Impact":
      return oneshot(f);
    case "BassOneShot":
      return bass(f);
    case "MelodicOneShot":
    case "WavetableCandidate":
      return melodic(f);
    case "VocalChop":
    case "MelodicPhrase":
    case "SliceLoop":
      return phrase(f);
    default:
      return 0.5;
  }
}
