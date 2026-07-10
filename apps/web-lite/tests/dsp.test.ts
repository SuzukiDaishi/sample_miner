import { describe, it, expect } from "vitest";
import { fftComplex, ifftComplex, magnitudeSpectrum } from "../src/analysis/fft";
import { detectOnsets } from "../src/analysis/onset";
import { buildSlices } from "../src/analysis/slice";
import { yinPitch, yinTrack, hzToMidi, midiToNoteName } from "../src/analysis/yin";
import { computeFeatures } from "../src/analysis/features";
import { classify } from "../src/analysis/classify";
import {
  extractWavetable,
  phaseAlignFrame,
  FRAME_LEN,
  FRAMES,
} from "../src/analysis/wavetable-extract";
import { findBestLoop, renderLoop } from "../src/analysis/loop-search";
import { encodeWav, decodeWav } from "../src/audio/wav-encode";
import {
  encodeLoadTablePacket,
  parseLoadTablePacket,
} from "../src/synth/zwtl";

const SR = 44100;

function sine(freq: number, durationSec: number, sr = SR, amp = 0.8): Float32Array {
  const n = Math.floor(durationSec * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  }
  return out;
}

function saw(freq: number, durationSec: number, sr = SR, amp = 0.8): Float32Array {
  const n = Math.floor(durationSec * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const phase = ((freq * i) / sr) % 1;
    out[i] = amp * (2 * phase - 1);
  }
  return out;
}

/** 減衰するクリック(パーカッシブ)を time 位置に置いた信号 */
function clickTrain(times: number[], durationSec: number, sr = SR): Float32Array {
  const out = new Float32Array(Math.floor(durationSec * sr));
  for (const t of times) {
    const start = Math.floor(t * sr);
    for (let i = 0; i < Math.floor(0.05 * sr); i++) {
      if (start + i >= out.length) break;
      const env = Math.exp(-i / (0.005 * sr));
      out[start + i] += env * (Math.sin((2 * Math.PI * 3000 * i) / sr) * 0.9);
    }
  }
  return out;
}

describe("fft", () => {
  it("roundtrips through fft/ifft", () => {
    const n = 1024;
    const re = new Float32Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin(i * 0.1) + 0.3 * Math.cos(i * 0.37);
    const orig = Float32Array.from(re);
    const im = new Float32Array(n);
    fftComplex(re, im);
    ifftComplex(re, im);
    for (let i = 0; i < n; i++) {
      expect(re[i]).toBeCloseTo(orig[i], 4);
    }
  });

  it("finds the right bin for a pure tone", () => {
    const n = 1024;
    const k = 16;
    const frame = new Float32Array(n);
    for (let i = 0; i < n; i++) frame[i] = Math.sin((2 * Math.PI * k * i) / n);
    const mag = magnitudeSpectrum(frame);
    let maxBin = 0;
    for (let b = 1; b < mag.length; b++) if (mag[b] > mag[maxBin]) maxBin = b;
    expect(maxBin).toBe(k);
  });
});

describe("onset detection", () => {
  it("detects clicks near their true positions", () => {
    const times = [0.5, 1.0, 1.5, 2.0];
    const signal = clickTrain(times, 2.5);
    const onsets = detectOnsets(signal, SR);
    expect(onsets.length).toBe(times.length);
    for (let i = 0; i < times.length; i++) {
      const sec = onsets[i] / SR;
      expect(Math.abs(sec - times[i])).toBeLessThan(0.03);
    }
  });

  it("returns no onsets for silence", () => {
    const silence = new Float32Array(SR);
    expect(detectOnsets(silence, SR)).toHaveLength(0);
  });
});

describe("slices", () => {
  it("builds one slice per onset with tail cut", () => {
    const times = [0.5, 1.5];
    const signal = clickTrain(times, 2.5);
    const onsets = detectOnsets(signal, SR);
    const slices = buildSlices(signal, SR, onsets);
    expect(slices.length).toBe(2);
    // クリックは 50ms 程度で減衰するので tail 推定で 1 秒よりずっと短く切れる
    expect(slices[0].endSample - slices[0].startSample).toBeLessThan(SR * 0.5);
    expect(slices[0].startSample).toBeLessThanOrEqual(Math.floor(0.5 * SR));
  });

  it("falls back to whole-file slice when no onsets", () => {
    const signal = sine(220, 2.0);
    const slices = buildSlices(signal, SR, []);
    expect(slices.length).toBe(1);
    expect(slices[0].endSample).toBe(signal.length);
  });
});

describe("yin", () => {
  it("estimates 440Hz within 1Hz", () => {
    const buf = sine(440, 0.1).subarray(0, 4096);
    const r = yinPitch(buf, SR);
    expect(r.f0Hz).not.toBeNull();
    expect(Math.abs((r.f0Hz as number) - 440)).toBeLessThan(1);
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  it("reports low confidence for noise", () => {
    const buf = new Float32Array(4096);
    let seed = 1;
    for (let i = 0; i < buf.length; i++) {
      seed = (seed * 16807) % 2147483647;
      buf[i] = (seed / 2147483647) * 2 - 1;
    }
    const r = yinPitch(buf, SR);
    expect(r.confidence).toBeLessThan(0.6);
  });

  it("tracks stable pitch with low cents deviation", () => {
    const t = yinTrack(sine(220, 1.0), SR);
    expect(t.f0MedianHz).not.toBeNull();
    expect(Math.abs((t.f0MedianHz as number) - 220)).toBeLessThan(2);
    expect(t.f0StabilityCents as number).toBeLessThan(10);
    expect(t.voicedRatio).toBeGreaterThan(0.9);
  });

  it("midi helpers", () => {
    expect(hzToMidi(440)).toBeCloseTo(69, 5);
    expect(midiToNoteName(69)).toBe("A4");
    expect(midiToNoteName(60)).toBe("C4");
  });
});

describe("features + classify", () => {
  it("classifies a decaying click as PercussiveOneShot", () => {
    const click = clickTrain([0.005], 0.4);
    const f = computeFeatures(click, SR);
    expect(f.attackMs).toBeLessThan(35);
    expect(classify(f)).toBe("PercussiveOneShot");
  });

  it("classifies a stable tone as WavetableCandidate", () => {
    const tone = sine(330, 1.0);
    const f = computeFeatures(tone, SR);
    expect(f.pitchConfidence ?? 0).toBeGreaterThan(0.7);
    expect(classify(f)).toBe("WavetableCandidate");
  });

  it("classifies silence as Reject", () => {
    const f = computeFeatures(new Float32Array(SR), SR);
    expect(classify(f)).toBe("Reject");
  });
});

describe("catchiness (docs 08 Layer A)", () => {
  it("computes presence / crest / pitch range features", () => {
    const bright = sine(3000, 0.5);
    expect(computeFeatures(bright, SR).presenceRatio).toBeGreaterThan(0.8);
    const low = computeFeatures(sine(200, 0.5), SR);
    expect(low.presenceRatio).toBeLessThan(0.05);
    expect(low.crestDb).toBeLessThan(6); // 正弦波の crest は約 3dB
    expect(low.pitchRangeSemitones ?? 99).toBeLessThan(1); // 動かないピッチ
    const click = clickTrain([0.005], 0.4);
    expect(computeFeatures(click, SR).crestDb).toBeGreaterThan(8);
  });

  it("scores a punchy click above a dull thud for one-shots", async () => {
    const { catchinessScore } = await import("../src/analysis/catchiness");
    const bright = clickTrain([0.005], 0.4);
    const n = Math.floor(0.4 * SR);
    const dull = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      dull[i] =
        0.5 *
        Math.sin(2 * Math.PI * 100 * t) *
        Math.min(1, t / 0.03) *
        Math.exp(-t / 0.3);
    }
    const cb = catchinessScore(computeFeatures(bright, SR), "PercussiveOneShot");
    const cd = catchinessScore(computeFeatures(dull, SR), "PercussiveOneShot");
    expect(cb).toBeGreaterThan(cd);
  });

  it("scores a moving melody above a static tone for phrases", async () => {
    const { catchinessScore } = await import("../src/analysis/catchiness");
    const notes = [261.6, 329.6, 392.0, 329.6];
    const moving = new Float32Array(notes.length * Math.floor(0.4 * SR));
    let off = 0;
    for (const f of notes) {
      moving.set(sine(f, 0.4), off);
      off += Math.floor(0.4 * SR);
    }
    const cm = catchinessScore(computeFeatures(moving, SR), "MelodicPhrase");
    const cs = catchinessScore(computeFeatures(sine(261.6, 1.6), SR), "MelodicPhrase");
    expect(cm).toBeGreaterThan(cs);
  });
});

describe("wavetable extraction", () => {
  it("extracts 8x2048 frames from a sawtooth and preserves shape", () => {
    const signal = saw(110, 1.0);
    const wt = extractWavetable(signal, SR, "test");
    expect(wt.frames).toBe(FRAMES);
    expect(wt.frameLen).toBe(FRAME_LEN);
    expect(wt.samples.length).toBe(FRAMES * FRAME_LEN);
    expect(wt.rootNote).toBe(45); // A2 = 110Hz

    // 各 frame が正規化されている
    for (let f = 0; f < FRAMES; f++) {
      const frame = wt.samples.subarray(f * FRAME_LEN, (f + 1) * FRAME_LEN);
      let peak = 0;
      let mean = 0;
      for (let i = 0; i < FRAME_LEN; i++) {
        peak = Math.max(peak, Math.abs(frame[i]));
        mean += frame[i];
      }
      expect(peak).toBeGreaterThan(0.9);
      expect(peak).toBeLessThanOrEqual(1.001);
      expect(Math.abs(mean / FRAME_LEN)).toBeLessThan(0.01); // DC 除去済み

      // ノコギリ波: 基本波が最大の harmonic
      const mag = magnitudeSpectrum(Float32Array.from(frame));
      let maxBin = 1;
      for (let b = 1; b < 64; b++) if (mag[b] > mag[maxBin]) maxBin = b;
      expect(maxBin).toBe(1);
      // 2 倍音はおよそ 1/2(saw の -6dB/oct 特性)
      expect(mag[2] / mag[1]).toBeGreaterThan(0.3);
      expect(mag[2] / mag[1]).toBeLessThan(0.7);
    }
  });

  it("rejects unpitched noise", () => {
    const buf = new Float32Array(SR);
    let seed = 7;
    for (let i = 0; i < buf.length; i++) {
      seed = (seed * 16807) % 2147483647;
      buf[i] = (seed / 2147483647) * 2 - 1;
    }
    expect(() => extractWavetable(buf, SR, "noise")).toThrow();
  });
});

describe("phaseAlignFrame", () => {
  it("aligns fundamental to sine phase and removes DC", () => {
    // 位相をずらしたサイン + DC オフセット
    const frame = new Float32Array(2048);
    for (let i = 0; i < 2048; i++) {
      frame[i] = Math.sin((2 * Math.PI * i) / 2048 + 1.3) + 0.25;
    }
    const aligned = phaseAlignFrame(frame);
    // sin 開始: frame[0] ≈ 0, 前半が正
    expect(Math.abs(aligned[0])).toBeLessThan(0.02);
    expect(aligned[512]).toBeGreaterThan(0.9);
    let mean = 0;
    for (let i = 0; i < 2048; i++) mean += aligned[i];
    expect(Math.abs(mean / 2048)).toBeLessThan(0.001);
  });
});

describe("loop search", () => {
  it("finds a seamless loop in periodic material", () => {
    const signal = sine(200, 4.0, SR, 0.7);
    const loop = findBestLoop(signal, SR, 0.05);
    expect(loop).not.toBeNull();
    const l = loop!;
    // 周期信号なので端点差はほぼゼロの loop が見つかるはず
    expect(l.score).toBeLessThan(0.1);
    const rendered = renderLoop(signal, SR, l);
    expect(rendered.length).toBe(l.endSample - l.startSample);
    // 継ぎ目: 末尾と先頭がほぼ連続している
    const gap = Math.abs(rendered[rendered.length - 1] - rendered[0]);
    expect(gap).toBeLessThan(0.15);
  });

  it("returns null for too-short input", () => {
    expect(findBestLoop(sine(200, 0.2), SR, 0.05)).toBeNull();
  });
});

describe("wav encode/decode roundtrip", () => {
  it("roundtrips 16bit stereo", () => {
    const l = sine(440, 0.05);
    const r = sine(220, 0.05);
    const bytes = encodeWav([l, r], SR, 16);
    const decoded = decodeWav(bytes);
    expect(decoded.sampleRate).toBe(SR);
    expect(decoded.channels.length).toBe(2);
    expect(decoded.channels[0].length).toBe(l.length);
    for (let i = 0; i < l.length; i += 100) {
      expect(decoded.channels[0][i]).toBeCloseTo(l[i], 3);
      expect(decoded.channels[1][i]).toBeCloseTo(r[i], 3);
    }
  });

  it("roundtrips 32bit float exactly", () => {
    const x = sine(1000, 0.01);
    const decoded = decodeWav(encodeWav([x], SR, 32));
    for (let i = 0; i < x.length; i++) {
      expect(decoded.channels[0][i]).toBeCloseTo(x[i], 6);
    }
  });
});

describe("ZWTL packet", () => {
  it("roundtrips encode → parse", () => {
    const samples = new Float32Array(8 * 2048);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i * 0.01);
    const bytes = encodeLoadTablePacket({
      slot: 3,
      rootNote: 57,
      frameCount: 8,
      frameLen: 2048,
      samples,
    });
    expect(bytes.length).toBe(12 + samples.length * 4);
    const packet = parseLoadTablePacket(bytes);
    expect(packet).not.toBeNull();
    expect(packet!.slot).toBe(3);
    expect(packet!.frameCount).toBe(8);
    expect(packet!.frameLen).toBe(2048);
    expect(packet!.rootNote).toBe(57);
    for (let i = 0; i < samples.length; i += 500) {
      expect(packet!.samples[i]).toBeCloseTo(samples[i], 6);
    }
  });

  it("rejects wrong magic and truncated payload", () => {
    const samples = new Float32Array(2048);
    const bytes = encodeLoadTablePacket({
      slot: 0,
      rootNote: 60,
      frameCount: 1,
      frameLen: 2048,
      samples,
    });
    const bad = Uint8Array.from(bytes);
    bad[0] = 0x58;
    expect(parseLoadTablePacket(bad)).toBeNull();
    expect(parseLoadTablePacket(bytes.subarray(0, bytes.length - 4))).toBeNull();
  });
});
