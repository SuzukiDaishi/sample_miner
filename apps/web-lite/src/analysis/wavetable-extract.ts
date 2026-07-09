/**
 * wavetable 抽出。docs 01 §6 / docs 02 の手順:
 * f0 track → stable region → 8 frame 地点 → 周期切り出し → cycle averaging
 * → phase align → DC 除去 → 2048 samples 化 → normalize
 */
import { fftComplex, ifftComplex } from "./fft";
import { resampleCubicCyclic } from "../audio/resample";
import { yinTrack, yinPitch, hzToMidi, type PitchTrackPoint } from "./yin";

export const FRAME_LEN = 2048;
export const FRAMES = 8;

export type ExtractedWavetable = {
  name: string;
  frameLen: typeof FRAME_LEN;
  frames: typeof FRAMES;
  rootNote: number; // MIDI
  sourcePitchHz: number;
  samples: Float32Array; // frames * frameLen
  quality: {
    pitchConfidence: number;
    pitchStabilityCents: number;
    periodicity: number;
  };
};

export class WavetableExtractError extends Error {}

const VOICED_CONF = 0.5;
const STABLE_CENTS = 35;

/**
 * pitch track から「連続して voiced かつ median から STABLE_CENTS 以内」の
 * 最長 run を探し、そのサンプル範囲を返す。
 */
function findStableRegion(
  points: PitchTrackPoint[],
  medianHz: number,
  sampleRate: number,
  totalSamples: number
): { start: number; end: number; indices: number[] } | null {
  const ok = points.map(
    (p) =>
      p.f0Hz !== null &&
      p.confidence >= VOICED_CONF &&
      Math.abs(1200 * Math.log2(p.f0Hz / medianHz)) < STABLE_CENTS
  );

  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < ok.length; i++) {
    if (ok[i]) {
      if (curStart < 0) curStart = i;
      curLen++;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  if (bestStart < 0 || bestLen < 1) return null;

  const indices = [];
  for (let i = bestStart; i < bestStart + bestLen; i++) indices.push(i);

  const startSec = points[bestStart].timeSec;
  const lastIdx = bestStart + bestLen - 1;
  const endSec =
    lastIdx + 1 < points.length
      ? points[lastIdx + 1].timeSec
      : totalSamples / sampleRate;

  return {
    start: Math.floor(startSec * sampleRate),
    end: Math.min(totalSamples, Math.ceil(endSec * sampleRate)),
    indices,
  };
}

/**
 * position 周辺で複数周期を切り出して平均した 1 周期波形を返す。
 */
function extractAveragedCycle(
  mono: Float32Array,
  position: number,
  period: number,
  cycles = 4
): Float32Array | null {
  const periodInt = Math.max(4, Math.round(period));
  const need = periodInt * cycles;
  let start = Math.round(position - need / 2);
  start = Math.max(0, Math.min(mono.length - need, start));
  if (start < 0 || mono.length < need) return null;

  const acc = new Float64Array(periodInt);
  for (let c = 0; c < cycles; c++) {
    const base = start + c * periodInt;
    for (let i = 0; i < periodInt; i++) {
      acc[i] += mono[base + i];
    }
  }
  const cycle = new Float32Array(periodInt);
  for (let i = 0; i < periodInt; i++) cycle[i] = acc[i] / cycles;
  return cycle;
}

/**
 * FFT で DC 除去 + 基本波の位相を 0(サイン開始)に揃える。
 * 全高調波を e^{-i k φ} で回す = 時間方向の循環シフトなので波形は歪まない。
 */
export function phaseAlignFrame(frame: Float32Array): Float32Array {
  const n = frame.length;
  const re = Float32Array.from(frame);
  const im = new Float32Array(n);
  fftComplex(re, im);

  // DC / Nyquist 除去
  re[0] = 0;
  im[0] = 0;
  re[n >> 1] = 0;
  im[n >> 1] = 0;

  // 基本波位相 φ を求め、sin 開始(位相 -π/2)へ回転
  const phi = Math.atan2(im[1], re[1]);
  const shift = phi + Math.PI / 2;

  for (let k = 1; k < n >> 1; k++) {
    const ang = -k * shift;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const r = re[k] * c - im[k] * s;
    const i2 = re[k] * s + im[k] * c;
    re[k] = r;
    im[k] = i2;
    // 実信号の共役対称性を維持
    re[n - k] = r;
    im[n - k] = -i2;
  }

  ifftComplex(re, im);
  return re;
}

function normalizeFrame(frame: Float32Array): void {
  let peak = 0;
  for (let i = 0; i < frame.length; i++) {
    const a = Math.abs(frame[i]);
    if (a > peak) peak = a;
  }
  if (peak > 1e-6) {
    const g = 1 / peak;
    for (let i = 0; i < frame.length; i++) frame[i] *= g;
  }
}

/**
 * region(mono buffer)から 8 frame × 2048 samples の wavetable を抽出する。
 */
export function extractWavetable(
  region: Float32Array,
  sampleRate: number,
  name: string
): ExtractedWavetable {
  const track = yinTrack(region, sampleRate, undefined, 2048, 64);
  if (track.f0MedianHz === null) {
    throw new WavetableExtractError(
      "pitch が検出できませんでした。ピッチの安定した区間を選択してください。"
    );
  }

  const stable = findStableRegion(
    track.points,
    track.f0MedianHz,
    sampleRate,
    region.length
  );
  if (!stable || stable.end - stable.start < sampleRate / track.f0MedianHz * 6) {
    throw new WavetableExtractError(
      "pitch の安定した区間が短すぎます。より長い安定区間を選択してください。"
    );
  }

  const samples = new Float32Array(FRAMES * FRAME_LEN);
  const span = stable.end - stable.start;

  for (let f = 0; f < FRAMES; f++) {
    // 安定区間を時間方向に 8 地点でサンプリング
    const t = f / (FRAMES - 1);
    const position = Math.round(stable.start + t * Math.max(0, span - 1));

    // 地点ローカルの f0 を測り直す(グライドに追従)
    const winLen = Math.min(4096, region.length);
    const winStart = Math.max(
      0,
      Math.min(region.length - winLen, position - winLen / 2)
    );
    const local = yinPitch(
      region.subarray(winStart, winStart + winLen),
      sampleRate
    );
    const f0 =
      local.f0Hz !== null &&
      Math.abs(1200 * Math.log2(local.f0Hz / track.f0MedianHz)) < 700
        ? local.f0Hz
        : track.f0MedianHz;

    const period = sampleRate / f0;
    const cycle = extractAveragedCycle(region, position, period);
    if (!cycle) {
      throw new WavetableExtractError("周期の切り出しに失敗しました。");
    }

    const resampled = resampleCubicCyclic(cycle, FRAME_LEN);
    const aligned = phaseAlignFrame(resampled);
    normalizeFrame(aligned);
    samples.set(aligned, f * FRAME_LEN);
  }

  return {
    name,
    frameLen: FRAME_LEN,
    frames: FRAMES,
    rootNote: Math.round(hzToMidi(track.f0MedianHz)),
    sourcePitchHz: track.f0MedianHz,
    samples,
    quality: {
      pitchConfidence: track.f0Confidence,
      pitchStabilityCents: track.f0StabilityCents ?? 0,
      periodicity: track.f0Confidence,
    },
  };
}
