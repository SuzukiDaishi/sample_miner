/**
 * ルールベース分類。docs 01 §5 の TypeScript 例 + docs 02 の
 * wavetable candidate 判定(conf>0.7, stability<20cents, dur>300ms)。
 */
import type { AssetType } from "../manifest/schema";
import type { SliceFeatures } from "./features";

const SILENCE_PEAK_DB = -55;

export function classify(features: SliceFeatures): AssetType {
  if (features.peakDb < SILENCE_PEAK_DB) {
    return "Reject";
  }

  if (
    features.durationSec < 1.2 &&
    features.attackMs < 35 &&
    (features.pitchConfidence ?? 0) < 0.45
  ) {
    return "PercussiveOneShot";
  }

  // wavetable candidate: pitch が十分安定して持続する音
  if (
    features.durationSec > 0.3 &&
    (features.pitchConfidence ?? 0) > 0.7 &&
    (features.pitchStabilityCents ?? 999) < 20 &&
    (features.voicedRatio ?? 0) > 0.6
  ) {
    return "WavetableCandidate";
  }

  if (
    features.durationSec < 2.5 &&
    (features.pitchConfidence ?? 0) > 0.65 &&
    (features.pitchStabilityCents ?? 999) < 25
  ) {
    return "MelodicOneShot";
  }

  if (
    features.durationSec > 3.0 &&
    features.transientDensity < 1.0 &&
    (features.pitchConfidence ?? 0) > 0.6
  ) {
    return "DroneLoop";
  }

  if (
    features.durationSec > 3.0 &&
    features.spectralFlatness > 0.45 &&
    features.transientDensity < 1.0
  ) {
    return "NoiseTexture";
  }

  return "MelodicPhrase";
}

/** 分類の確からしさの簡易スコア。ルールベースなので目安。 */
export function classificationConfidence(
  type: AssetType,
  features: SliceFeatures
): number {
  switch (type) {
    case "Reject":
      return 0.9;
    case "PercussiveOneShot": {
      const fast = Math.max(0, 1 - features.attackMs / 35);
      const unpitched = 1 - (features.pitchConfidence ?? 0);
      return Math.min(0.95, 0.5 + 0.3 * fast + 0.2 * unpitched);
    }
    case "WavetableCandidate":
      return Math.min(0.95, features.pitchConfidence ?? 0.5);
    case "MelodicOneShot":
      return Math.min(0.9, features.pitchConfidence ?? 0.5);
    case "DroneLoop":
      return Math.min(0.85, 0.4 + (features.pitchConfidence ?? 0) * 0.5);
    case "NoiseTexture":
      return Math.min(0.85, 0.4 + features.spectralFlatness * 0.8);
    default:
      return 0.5;
  }
}
