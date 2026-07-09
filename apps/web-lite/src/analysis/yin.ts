/**
 * YIN pitch 推定 (de Cheveigné & Kawahara 2002)。
 * root note 推定 / melodic 判定 / wavetable・drone 候補判定に使う。
 */

export type YinResult = {
  f0Hz: number | null;
  /** 1 - CMNDF 最小値。高いほど周期性が強い。 */
  confidence: number;
};

export type YinConfig = {
  minHz: number;
  maxHz: number;
  threshold: number;
};

export const DEFAULT_YIN_CONFIG: YinConfig = {
  minHz: 50,
  maxHz: 1200,
  threshold: 0.15,
};

/** 1 窓分の YIN。buffer 長は sampleRate/minHz の 2 倍以上を推奨。 */
export function yinPitch(
  buffer: Float32Array,
  sampleRate: number,
  config: YinConfig = DEFAULT_YIN_CONFIG
): YinResult {
  const tauMin = Math.max(2, Math.floor(sampleRate / config.maxHz));
  const tauMax = Math.min(
    Math.floor(buffer.length / 2),
    Math.ceil(sampleRate / config.minHz)
  );
  if (tauMax <= tauMin + 2) return { f0Hz: null, confidence: 0 };

  const w = Math.floor(buffer.length / 2);

  // difference function
  const diff = new Float32Array(tauMax + 1);
  for (let tau = tauMin; tau <= tauMax; tau++) {
    let sum = 0;
    for (let i = 0; i < w; i++) {
      const d = buffer[i] - buffer[i + tau];
      sum += d * d;
    }
    diff[tau] = sum;
  }

  // cumulative mean normalized difference (CMNDF)
  const cmndf = new Float32Array(tauMax + 1);
  cmndf[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    runningSum += diff[tau] ?? 0;
    cmndf[tau] = runningSum > 0 ? (diff[tau] * tau) / runningSum : 1;
  }

  // absolute threshold: 最初に threshold を下回る谷を採用
  let tauEstimate = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cmndf[tau] < config.threshold) {
      while (tau + 1 <= tauMax && cmndf[tau + 1] < cmndf[tau]) tau++;
      tauEstimate = tau;
      break;
    }
  }
  // threshold 未達なら全体の最小値
  let minVal = Infinity;
  let minTau = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cmndf[tau] < minVal) {
      minVal = cmndf[tau];
      minTau = tau;
    }
  }
  if (tauEstimate < 0) tauEstimate = minTau;
  if (tauEstimate < 0) return { f0Hz: null, confidence: 0 };

  const confidence = Math.max(0, Math.min(1, 1 - cmndf[tauEstimate]));

  // parabolic interpolation で tau を補正
  let betterTau = tauEstimate;
  if (tauEstimate > tauMin && tauEstimate < tauMax) {
    const s0 = cmndf[tauEstimate - 1];
    const s1 = cmndf[tauEstimate];
    const s2 = cmndf[tauEstimate + 1];
    const denom = 2 * (2 * s1 - s2 - s0);
    if (Math.abs(denom) > 1e-12) {
      betterTau = tauEstimate + (s2 - s0) / denom;
    }
  }

  return { f0Hz: sampleRate / betterTau, confidence };
}

export type PitchTrackPoint = {
  timeSec: number;
  f0Hz: number | null;
  confidence: number;
};

export type PitchTrackSummary = {
  points: PitchTrackPoint[];
  f0MedianHz: number | null;
  f0Confidence: number;
  f0StabilityCents: number | null;
  voicedRatio: number;
};

const VOICED_CONFIDENCE = 0.5;

/**
 * buffer 全体の pitch track。コスト上限のため最大 maxFrames 地点で評価する。
 */
export function yinTrack(
  mono: Float32Array,
  sampleRate: number,
  config: YinConfig = DEFAULT_YIN_CONFIG,
  frameSize = 2048,
  maxFrames = 40
): PitchTrackSummary {
  const points: PitchTrackPoint[] = [];
  if (mono.length < frameSize) {
    const r = yinPitch(mono, sampleRate, config);
    points.push({ timeSec: 0, f0Hz: r.f0Hz, confidence: r.confidence });
  } else {
    const span = mono.length - frameSize;
    const idealHop = 512;
    const frames = Math.min(maxFrames, Math.max(1, Math.floor(span / idealHop) + 1));
    const hop = frames > 1 ? span / (frames - 1) : 0;
    for (let f = 0; f < frames; f++) {
      const start = Math.round(f * hop);
      const win = mono.subarray(start, start + frameSize);
      const r = yinPitch(win, sampleRate, config);
      points.push({
        timeSec: start / sampleRate,
        f0Hz: r.f0Hz,
        confidence: r.confidence,
      });
    }
  }

  const voiced = points.filter(
    (p) => p.f0Hz !== null && p.confidence >= VOICED_CONFIDENCE
  );
  const voicedRatio = points.length > 0 ? voiced.length / points.length : 0;

  if (voiced.length === 0) {
    return {
      points,
      f0MedianHz: null,
      f0Confidence: 0,
      f0StabilityCents: null,
      voicedRatio: 0,
    };
  }

  const f0s = voiced.map((p) => p.f0Hz as number).sort((a, b) => a - b);
  const median = f0s[Math.floor(f0s.length / 2)];

  // confidence は全フレーム平均。voiced のみの平均だと
  // 減衰音の短い ring だけで高くなり melodic 誤判定の原因になる。
  const meanConf =
    points.reduce((acc, p) => acc + p.confidence, 0) / points.length;

  // median からの偏差 (cents) の標準偏差
  let stability: number | null = null;
  if (voiced.length >= 2) {
    const cents = voiced.map(
      (p) => 1200 * Math.log2((p.f0Hz as number) / median)
    );
    const mean = cents.reduce((a, b) => a + b, 0) / cents.length;
    const variance =
      cents.reduce((a, c) => a + (c - mean) * (c - mean), 0) / cents.length;
    stability = Math.sqrt(variance);
  } else {
    stability = 0;
  }

  return {
    points,
    f0MedianHz: median,
    f0Confidence: meanConf,
    f0StabilityCents: stability,
    voicedRatio,
  };
}

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];

export function midiToNoteName(midi: number): string {
  const m = Math.round(midi);
  const name = NOTE_NAMES[((m % 12) + 12) % 12];
  const octave = Math.floor(m / 12) - 1;
  return `${name}${octave}`;
}
