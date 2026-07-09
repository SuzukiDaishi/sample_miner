/**
 * drone / ambience loop point 探索。docs 01 §7 の loop score:
 * score = waveform_endpoint_distance * 0.4
 *       + rms_difference * 0.2
 *       + spectral_distance * 0.3
 *       + transient_penalty * 0.1
 */
import { magnitudeSpectrum } from "./fft";
import { hannWindow } from "./stft";
import { rmsEnvelope } from "./onset";

export type LoopSearchConfig = {
  minLoopSec: number;
  maxLoopSec: number;
  startCandidates: number;
  lengthCandidates: number;
};

export const DEFAULT_LOOP_CONFIG: LoopSearchConfig = {
  minLoopSec: 1.0,
  maxLoopSec: 8.0,
  startCandidates: 16,
  lengthCandidates: 12,
};

export type LoopResult = {
  startSample: number;
  endSample: number;
  crossfadeMs: number;
  score: number;
};

const SPEC_SIZE = 2048;

function spectrumAt(
  mono: Float32Array,
  center: number,
  window: Float32Array
): Float32Array {
  const half = SPEC_SIZE / 2;
  let start = Math.max(0, Math.min(mono.length - SPEC_SIZE, center - half));
  const buf = new Float32Array(SPEC_SIZE);
  for (let i = 0; i < SPEC_SIZE; i++) {
    buf[i] = mono[start + i] * window[i];
  }
  return magnitudeSpectrum(buf);
}

function spectralDistance(a: Float32Array, b: Float32Array): number {
  let num = 0;
  let den = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    num += d * d;
    den += a[i] * a[i] + b[i] * b[i];
  }
  return den > 0 ? Math.sqrt(num / den) : 0;
}

function rmsAt(mono: Float32Array, center: number, win: number): number {
  const start = Math.max(0, Math.min(mono.length - win, center - win / 2));
  let sum = 0;
  for (let i = 0; i < win; i++) sum += mono[start + i] * mono[start + i];
  return Math.sqrt(sum / win);
}

function waveformEndpointDistance(
  mono: Float32Array,
  start: number,
  end: number,
  win = 128
): number {
  let sum = 0;
  let energy = 0;
  for (let i = 0; i < win; i++) {
    const a = mono[Math.min(mono.length - 1, start + i)];
    const b = mono[Math.min(mono.length - 1, end + i)];
    sum += Math.abs(a - b);
    energy += Math.abs(a) + Math.abs(b);
  }
  return energy > 0 ? sum / energy : 0;
}

/**
 * mono buffer 内で最良の loop point を探索する。
 * crossfade 分の助走が必要なので start >= crossfade 長を候補条件にする。
 */
export function findBestLoop(
  mono: Float32Array,
  sampleRate: number,
  spectralFlatness: number,
  config: LoopSearchConfig = DEFAULT_LOOP_CONFIG
): LoopResult | null {
  const durationSec = mono.length / sampleRate;
  const minLoop = Math.floor(config.minLoopSec * sampleRate);
  const maxLoop = Math.floor(
    Math.min(config.maxLoopSec, durationSec * 0.9) * sampleRate
  );
  if (maxLoop <= minLoop) return null;

  // crossfade: tonal 60ms / noisy 250ms(docs 01 §7 の素材別レンジから)
  const crossfadeMs = spectralFlatness > 0.3 ? 250 : 60;
  const crossfade = Math.floor((crossfadeMs / 1000) * sampleRate);

  const window = hannWindow(SPEC_SIZE);
  const rmsWin = Math.floor(0.05 * sampleRate);

  // transient penalty 用の粗い envelope
  const envWin = 512;
  const env = rmsEnvelope(mono, envWin);
  let envMean = 0;
  for (let i = 0; i < env.length; i++) envMean += env[i];
  envMean /= Math.max(1, env.length);

  let best: LoopResult | null = null;

  const startMin = crossfade;
  const startMax = Math.max(startMin + 1, mono.length - minLoop - 1);

  for (let si = 0; si < config.startCandidates; si++) {
    const start = Math.floor(
      startMin +
        (si / Math.max(1, config.startCandidates - 1)) * (startMax - startMin)
    );
    const specStart = spectrumAt(mono, start, window);
    const rmsStart = rmsAt(mono, start, rmsWin);

    for (let li = 0; li < config.lengthCandidates; li++) {
      const len = Math.floor(
        minLoop +
          (li / Math.max(1, config.lengthCandidates - 1)) * (maxLoop - minLoop)
      );
      const end = start + len;
      if (end + 128 >= mono.length) continue;

      const specEnd = spectrumAt(mono, end, window);
      const rmsEnd = rmsAt(mono, end, rmsWin);

      const wDist = waveformEndpointDistance(mono, start, end);
      const rmsDiff =
        rmsStart + rmsEnd > 0
          ? Math.abs(rmsStart - rmsEnd) / (rmsStart + rmsEnd)
          : 0;
      const sDist = spectralDistance(specStart, specEnd);

      // loop 端付近に envelope 平均の 2 倍を超えるスパイクがあればペナルティ
      let transientPenalty = 0;
      const edgeWindows = [start, end].map((p) => Math.floor(p / envWin));
      for (const w of edgeWindows) {
        for (let k = Math.max(0, w - 2); k <= Math.min(env.length - 1, w + 2); k++) {
          if (env[k] > envMean * 2) transientPenalty += 0.5;
        }
      }
      transientPenalty = Math.min(1, transientPenalty);

      const score =
        wDist * 0.4 + rmsDiff * 0.2 + sDist * 0.3 + transientPenalty * 0.1;

      if (!best || score < best.score) {
        best = { startSample: start, endSample: end, crossfadeMs, score };
      }
    }
  }

  return best;
}

/**
 * loop region を crossfade 済みのシームレスな buffer として render する。
 * 末尾 crossfade 分は「loop start 直前の音」とブレンドするので、
 * 再生側は単純に全体を loop すればつながる。
 */
export function renderLoop(
  mono: Float32Array,
  sampleRate: number,
  loop: LoopResult
): Float32Array {
  const len = loop.endSample - loop.startSample;
  const out = new Float32Array(len);
  out.set(mono.subarray(loop.startSample, loop.endSample));

  const cf = Math.min(
    Math.floor((loop.crossfadeMs / 1000) * sampleRate),
    loop.startSample,
    Math.floor(len / 2)
  );
  if (cf <= 0) return out;

  for (let j = 0; j < cf; j++) {
    const t = (j + 1) / (cf + 1);
    // equal-power crossfade: 末尾を loop start 直前の音へ滑らかに移行させる
    const gainA = Math.cos((t * Math.PI) / 2);
    const gainB = Math.sin((t * Math.PI) / 2);
    const i = len - cf + j;
    const pre = mono[loop.startSample - cf + j];
    out[i] = out[i] * gainA + pre * gainB;
  }

  return out;
}
