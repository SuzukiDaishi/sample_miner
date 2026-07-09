/**
 * slice 生成 + tail 推定。
 * docs 02: start = onset - 5ms,
 * end = min(next_onset - 5ms, RMS < peak - 40dB 到達点, onset + maxDuration)
 */
import { rmsEnvelope } from "./onset";

export type Slice = {
  id: string;
  startSample: number;
  endSample: number;
  onsetSample: number;
};

export type SliceConfig = {
  preOnsetMs: number;
  tailDbDrop: number;
  maxDurationSec: number;
  minDurationMs: number;
};

export const DEFAULT_SLICE_CONFIG: SliceConfig = {
  preOnsetMs: 5,
  tailDbDrop: 40,
  maxDurationSec: 10,
  minDurationMs: 30,
};

/** peak RMS から tailDbDrop 下がった位置を探す。見つからなければ endLimit。 */
function findTailEnd(
  env: Float32Array,
  envWindow: number,
  startSample: number,
  endLimitSample: number,
  tailDbDrop: number
): number {
  const startW = Math.floor(startSample / envWindow);
  const endW = Math.min(env.length - 1, Math.floor(endLimitSample / envWindow));

  let peak = 0;
  let peakW = startW;
  for (let w = startW; w <= endW; w++) {
    if (env[w] > peak) {
      peak = env[w];
      peakW = w;
    }
  }
  if (peak <= 0) return endLimitSample;

  const threshold = peak * Math.pow(10, -tailDbDrop / 20);
  for (let w = peakW + 1; w <= endW; w++) {
    if (env[w] < threshold) {
      return Math.min(endLimitSample, (w + 1) * envWindow);
    }
  }
  return endLimitSample;
}

export function buildSlices(
  mono: Float32Array,
  sampleRate: number,
  onsets: number[],
  config: SliceConfig = DEFAULT_SLICE_CONFIG
): Slice[] {
  const preOnset = Math.round((config.preOnsetMs / 1000) * sampleRate);
  const maxDur = Math.round(config.maxDurationSec * sampleRate);
  const minDur = Math.round((config.minDurationMs / 1000) * sampleRate);

  const envWindow = 256;
  const env = rmsEnvelope(mono, envWindow);

  // onset が 1 つもない場合はファイル全体を 1 slice にする(drone/ambience 用)
  if (onsets.length === 0) {
    if (mono.length < minDur) return [];
    return [
      {
        id: "slice_001",
        startSample: 0,
        endSample: mono.length,
        onsetSample: 0,
      },
    ];
  }

  const slices: Slice[] = [];
  for (let i = 0; i < onsets.length; i++) {
    const onset = onsets[i];
    const start = Math.max(0, onset - preOnset);
    const nextOnsetLimit =
      i + 1 < onsets.length
        ? Math.max(start + 1, onsets[i + 1] - preOnset)
        : mono.length;
    const endLimit = Math.min(mono.length, nextOnsetLimit, onset + maxDur);

    const end = findTailEnd(env, envWindow, start, endLimit, config.tailDbDrop);
    if (end - start < minDur) continue;

    slices.push({
      id: `slice_${String(slices.length + 1).padStart(3, "0")}`,
      startSample: start,
      endSample: end,
      onsetSample: onset,
    });
  }
  return slices;
}
