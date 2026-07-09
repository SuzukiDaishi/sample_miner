/**
 * 軽量版の音響特徴抽出。docs 02 の AudioFeatures 準拠。
 * pitch 系は解析コスト削減のため 16kHz 相当へ間引いてから YIN を回す。
 */
import { stftMagnitudes } from "./stft";
import { spectralFlux, pickPeaks, DEFAULT_ONSET_CONFIG, rmsEnvelope } from "./onset";
import { yinTrack, DEFAULT_YIN_CONFIG } from "./yin";

export type SliceFeatures = {
  durationSec: number;
  rmsDb: number;
  peakDb: number;
  attackMs: number;
  decayMs: number;

  zeroCrossingRate: number;
  spectralCentroid: number;
  spectralFlatness: number;
  transientDensity: number;

  pitchHz?: number;
  pitchConfidence?: number;
  pitchStabilityCents?: number;
  voicedRatio?: number;
};

function toDb(v: number): number {
  return 20 * Math.log10(Math.max(v, 1e-10));
}

/** 整数間引きによる簡易ダウンサンプル(pitch 解析用)。 */
export function decimateForPitch(
  mono: Float32Array,
  sampleRate: number,
  targetRate = 16000
): { buffer: Float32Array; sampleRate: number } {
  const factor = Math.max(1, Math.floor(sampleRate / targetRate));
  if (factor === 1) return { buffer: mono, sampleRate };
  const outLen = Math.floor(mono.length / factor);
  const out = new Float32Array(outLen);
  // 簡易 anti-alias: factor 幅の移動平均をかけてから間引く
  for (let i = 0; i < outLen; i++) {
    let sum = 0;
    const base = i * factor;
    for (let k = 0; k < factor; k++) sum += mono[base + k];
    out[i] = sum / factor;
  }
  return { buffer: out, sampleRate: sampleRate / factor };
}

/** 解析コスト上限: STFT 系特徴は先頭 maxAnalysisSec のみ見る。 */
const MAX_ANALYSIS_SEC = 12;

export function computeFeatures(
  slice: Float32Array,
  sampleRate: number
): SliceFeatures {
  const durationSec = slice.length / sampleRate;
  const analysisLen = Math.min(
    slice.length,
    Math.floor(MAX_ANALYSIS_SEC * sampleRate)
  );
  const buf = slice.subarray(0, analysisLen);

  // RMS / peak
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    sumSq += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sumSq / Math.max(1, buf.length));

  // attack / decay: 5ms RMS envelope から
  const envWindow = Math.max(32, Math.round(sampleRate * 0.005));
  const env = rmsEnvelope(buf, envWindow);
  let envPeak = 0;
  let envPeakIdx = 0;
  for (let i = 0; i < env.length; i++) {
    if (env[i] > envPeak) {
      envPeak = env[i];
      envPeakIdx = i;
    }
  }
  // attack: 先頭から envelope が peak の 90% に達するまで
  let attackIdx = envPeakIdx;
  for (let i = 0; i <= envPeakIdx; i++) {
    if (env[i] >= envPeak * 0.9) {
      attackIdx = i;
      break;
    }
  }
  const attackMs = (attackIdx * envWindow * 1000) / sampleRate;
  // decay: peak から -20dB に落ちるまで
  const decayThreshold = envPeak * Math.pow(10, -20 / 20);
  let decayIdx = env.length - 1;
  for (let i = envPeakIdx + 1; i < env.length; i++) {
    if (env[i] < decayThreshold) {
      decayIdx = i;
      break;
    }
  }
  const decayMs = ((decayIdx - envPeakIdx) * envWindow * 1000) / sampleRate;

  // zero crossing rate (crossings per sample, 0..1)
  let crossings = 0;
  for (let i = 1; i < buf.length; i++) {
    if ((buf[i - 1] >= 0) !== (buf[i] >= 0)) crossings++;
  }
  const zcr = crossings / Math.max(1, buf.length - 1);

  // spectral centroid / flatness (STFT frame 平均)
  let centroid = 0;
  let flatness = 0;
  let transientDensity = 0;
  if (buf.length >= 2048) {
    const { frames } = stftMagnitudes(buf, 1024, 512);
    if (frames.length > 0) {
      const binHz = sampleRate / 1024;
      let centroidSum = 0;
      let flatnessSum = 0;
      for (const mag of frames) {
        let wSum = 0;
        let mSum = 0;
        let logSum = 0;
        let linSum = 0;
        for (let k = 1; k < mag.length; k++) {
          wSum += k * binHz * mag[k];
          mSum += mag[k];
          const p = mag[k] * mag[k] + 1e-12;
          logSum += Math.log(p);
          linSum += p;
        }
        centroidSum += mSum > 0 ? wSum / mSum : 0;
        const n = mag.length - 1;
        flatnessSum += Math.exp(logSum / n) / (linSum / n);
      }
      centroid = centroidSum / frames.length;
      flatness = flatnessSum / frames.length;
    }

    // transient density: slice 内の flux peak 数 / 秒
    const fluxFrames = stftMagnitudes(buf, 1024, 256).frames;
    if (fluxFrames.length >= 3) {
      const flux = spectralFlux(fluxFrames);
      let max = 0;
      for (let i = 0; i < flux.length; i++) if (flux[i] > max) max = flux[i];
      if (max > 0) for (let i = 0; i < flux.length; i++) flux[i] /= max;
      const minIntervalFrames = Math.max(
        1,
        Math.round(0.06 * (sampleRate / 256))
      );
      const peaks = pickPeaks(flux, DEFAULT_ONSET_CONFIG, minIntervalFrames);
      transientDensity = peaks.length / (buf.length / sampleRate);
    }
  }

  // pitch (16kHz へ間引いて YIN)
  const { buffer: pitchBuf, sampleRate: pitchSr } = decimateForPitch(
    buf,
    sampleRate
  );
  const pitch = yinTrack(pitchBuf, pitchSr, DEFAULT_YIN_CONFIG);

  return {
    durationSec,
    rmsDb: toDb(rms),
    peakDb: toDb(peak),
    attackMs,
    decayMs,
    zeroCrossingRate: zcr,
    spectralCentroid: centroid,
    spectralFlatness: flatness,
    transientDensity,
    pitchHz: pitch.f0MedianHz ?? undefined,
    pitchConfidence: pitch.f0Confidence,
    pitchStabilityCents: pitch.f0StabilityCents ?? undefined,
    voicedRatio: pitch.voicedRatio,
  };
}
