/**
 * onset 検出: spectral flux → normalize → peak picking → onset backtracking。
 * docs 01 §3 / docs 02 の推奨パラメータ準拠。
 */
import { stftMagnitudes } from "./stft";

export type OnsetConfig = {
  fftSize: number;
  hopSize: number;
  minIntervalMs: number;
  threshold: number;
  preAverageFrames: number;
  postAverageFrames: number;
};

export const DEFAULT_ONSET_CONFIG: OnsetConfig = {
  fftSize: 1024,
  hopSize: 256,
  minIntervalMs: 60,
  threshold: 1.5,
  preAverageFrames: 8,
  postAverageFrames: 8,
};

/** flux[t] = sum(max(0, mag[t][bin] - mag[t-1][bin])) */
export function spectralFlux(frames: Float32Array[]): Float32Array {
  const flux = new Float32Array(frames.length);
  for (let t = 1; t < frames.length; t++) {
    const cur = frames[t];
    const prev = frames[t - 1];
    let sum = 0;
    for (let bin = 0; bin < cur.length; bin++) {
      const d = cur[bin] - prev[bin];
      if (d > 0) sum += d;
    }
    flux[t] = sum;
  }
  return flux;
}

function localAverage(
  flux: Float32Array,
  center: number,
  pre: number,
  post: number
): number {
  const start = Math.max(0, center - pre);
  const end = Math.min(flux.length - 1, center + post);
  let sum = 0;
  for (let i = start; i <= end; i++) sum += flux[i];
  return sum / (end - start + 1);
}

export function pickPeaks(
  flux: Float32Array,
  config: OnsetConfig,
  minIntervalFrames: number
): number[] {
  const peaks: number[] = [];
  let lastPeak = -Infinity;

  for (let i = 1; i < flux.length - 1; i++) {
    const isLocalMax = flux[i] > flux[i - 1] && flux[i] >= flux[i + 1];
    if (!isLocalMax) continue;

    const mean = localAverage(
      flux,
      i,
      config.preAverageFrames,
      config.postAverageFrames
    );
    // mean が 0 に近い無音区間で誤検出しないよう絶対閾値も併用
    if (flux[i] > mean * config.threshold && flux[i] > 1e-4) {
      if (i - lastPeak >= minIntervalFrames) {
        peaks.push(i);
        lastPeak = i;
      }
    }
  }

  return peaks;
}

/** 短窓 RMS envelope(hop = windowSize)を計算する。 */
export function rmsEnvelope(
  mono: Float32Array,
  windowSize: number
): Float32Array {
  const count = Math.max(1, Math.floor(mono.length / windowSize));
  const env = new Float32Array(count);
  for (let w = 0; w < count; w++) {
    const start = w * windowSize;
    const end = Math.min(mono.length, start + windowSize);
    let sum = 0;
    for (let i = start; i < end; i++) sum += mono[i] * mono[i];
    env[w] = Math.sqrt(sum / (end - start));
  }
  return env;
}

/**
 * onset backtracking: 検出点は実際の attack より遅れがちなので、
 * 直前の RMS 極小(local minimum)までサンプル位置を戻す。
 */
export function backtrackOnset(
  onsetSample: number,
  env: Float32Array,
  envWindowSize: number
): number {
  let w = Math.min(env.length - 1, Math.floor(onsetSample / envWindowSize));
  // 厳密な減少のみ遡る(<= だと無音のゼロ連続を先頭まで遡ってしまう)
  while (w > 0 && env[w - 1] < env[w]) {
    w--;
  }
  return w * envWindowSize;
}

/** mono buffer から onset サンプル位置の配列を返す。 */
export function detectOnsets(
  mono: Float32Array,
  sampleRate: number,
  config: OnsetConfig = DEFAULT_ONSET_CONFIG
): number[] {
  if (mono.length < config.fftSize * 2) return [];

  const { frames } = stftMagnitudes(mono, config.fftSize, config.hopSize);
  if (frames.length < 3) return [];

  const flux = spectralFlux(frames);

  // normalize
  let max = 0;
  for (let i = 0; i < flux.length; i++) if (flux[i] > max) max = flux[i];
  if (max > 0) {
    for (let i = 0; i < flux.length; i++) flux[i] /= max;
  }

  const minIntervalFrames = Math.max(
    1,
    Math.round((config.minIntervalMs / 1000) * (sampleRate / config.hopSize))
  );
  const peaks = pickPeaks(flux, config, minIntervalFrames);

  const envWindow = 256;
  const env = rmsEnvelope(mono, envWindow);

  const onsets: number[] = [];
  for (const p of peaks) {
    const rawSample = p * config.hopSize;
    const backtracked = backtrackOnset(rawSample, env, envWindow);
    const prev = onsets[onsets.length - 1];
    if (prev === undefined || backtracked > prev) {
      onsets.push(backtracked);
    }
  }
  return onsets;
}
