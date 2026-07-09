/**
 * 内蔵 wavetable プレビューシンセ (AudioWorkletProcessor)。
 * z-audio-webclap-wavetable の代替出口。ZWTL packet で wavetable をロードし、
 * FFT lowpass による mip 生成で alias を抑えて再生する。
 * ?url で読み込む自己完結ファイルのため依存 import はしない。
 */

const MIPS = 8; // mip m の最大 harmonic = 1024 >> m
const MAX_VOICES = 8;

/* ---- 自己完結 FFT (radix-2) ---- */
function fftComplex(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const tRe = re[b] * curRe - im[b] * curIm;
        const tIm = re[b] * curIm + im[b] * curRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/* ---- ZWTL parse (docs 04 準拠) ---- */
function parseLoadTablePacket(bytes) {
  if (
    bytes.length < 12 ||
    bytes[0] !== 0x5a ||
    bytes[1] !== 0x57 ||
    bytes[2] !== 0x54 ||
    bytes[3] !== 0x4c
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const slot = view.getUint8(4);
  const frameCount = view.getUint8(5);
  const frameLen = view.getUint16(6, true);
  const rootNote = view.getUint8(8);
  const sampleCount = frameCount * frameLen;
  if (bytes.length !== 12 + sampleCount * 4) return null;
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = view.getFloat32(12 + i * 4, true);
  }
  return { slot, frameCount, frameLen, rootNote, samples };
}

/**
 * frame (frameLen samples) から MIPS 段の bandlimited コピーを作る。
 * mip m は harmonic (frameLen/2) >> (m+1) 以下だけ残す。
 */
function buildMips(frame, frameLen) {
  const mips = [];
  const re = new Float32Array(frameLen);
  const im = new Float32Array(frameLen);
  re.set(frame);
  fftComplex(re, im, false);

  const baseMax = frameLen >> 1; // 1024

  for (let m = 0; m < MIPS; m++) {
    const maxHarmonic = Math.max(1, baseMax >> m);
    const mre = Float32Array.from(re);
    const mim = Float32Array.from(im);
    // DC と Nyquist、maxHarmonic を超える bin を落とす
    mre[0] = 0;
    mim[0] = 0;
    for (let k = 1; k < frameLen; k++) {
      const harmonic = k <= frameLen / 2 ? k : frameLen - k;
      if (harmonic > maxHarmonic) {
        mre[k] = 0;
        mim[k] = 0;
      }
    }
    fftComplex(mre, mim, true);
    mips.push(mre);
  }
  return mips;
}

class Voice {
  constructor() {
    this.active = false;
    this.key = -1;
    this.phase = 0;
    this.freq = 440;
    this.velocity = 1;
    this.env = 0;
    this.stage = "off"; // attack | decay | sustain | release | off
  }
}

class WavetableSynthProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.table = null; // { frameCount, frameLen, rootNote, frames: [ [mip0, mip1...] ] }
    this.wtPos = 0; // 0..1
    this.adsr = { a: 0.005, d: 0.2, s: 0.8, r: 0.3 };
    this.voices = [];
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new Voice());

    this.port.onmessage = (e) => this.handleMessage(e.data);
  }

  handleMessage(msg) {
    if (msg.type === "zwtl") {
      const packet = parseLoadTablePacket(new Uint8Array(msg.bytes));
      if (!packet) {
        this.port.postMessage({ type: "loadError" });
        return;
      }
      const frames = [];
      for (let f = 0; f < packet.frameCount; f++) {
        const frame = packet.samples.subarray(
          f * packet.frameLen,
          (f + 1) * packet.frameLen
        );
        frames.push(buildMips(frame, packet.frameLen));
      }
      this.table = {
        frameCount: packet.frameCount,
        frameLen: packet.frameLen,
        rootNote: packet.rootNote,
        frames,
      };
      // 全ボイス停止(旧テーブル参照を残さない)
      for (const v of this.voices) {
        v.active = false;
        v.stage = "off";
      }
      this.port.postMessage({ type: "loaded", rootNote: packet.rootNote });
    } else if (msg.type === "noteOn") {
      this.noteOn(msg.key, msg.velocity ?? 1);
    } else if (msg.type === "noteOff") {
      this.noteOff(msg.key);
    } else if (msg.type === "wtPos") {
      this.wtPos = Math.max(0, Math.min(1, msg.value));
    } else if (msg.type === "adsr") {
      this.adsr = { ...this.adsr, ...msg.value };
    } else if (msg.type === "allNotesOff") {
      for (const v of this.voices) {
        if (v.active) v.stage = "release";
      }
    }
  }

  noteOn(key, velocity) {
    if (!this.table) return;
    let voice = this.voices.find((v) => !v.active);
    if (!voice) {
      // 一番進んだ release voice を奪う
      voice = this.voices.find((v) => v.stage === "release") ?? this.voices[0];
    }
    voice.active = true;
    voice.key = key;
    voice.freq = 440 * Math.pow(2, (key - 69) / 12);
    voice.velocity = velocity;
    voice.phase = 0;
    voice.env = 0;
    voice.stage = "attack";
  }

  noteOff(key) {
    for (const v of this.voices) {
      if (v.active && v.key === key && v.stage !== "release") {
        v.stage = "release";
      }
    }
  }

  sampleTable(mipIdx, framePos, phase) {
    const t = this.table;
    const fMax = t.frameCount - 1;
    const fPos = framePos * fMax;
    const f0 = Math.min(fMax, Math.floor(fPos));
    const f1 = Math.min(fMax, f0 + 1);
    const fFrac = fPos - f0;

    const p = phase * t.frameLen;
    const i0 = Math.floor(p) % t.frameLen;
    const i1 = (i0 + 1) % t.frameLen;
    const pFrac = p - Math.floor(p);

    const m0 = t.frames[f0][mipIdx];
    const m1 = t.frames[f1][mipIdx];
    const a = m0[i0] + (m0[i1] - m0[i0]) * pFrac;
    const b = m1[i0] + (m1[i1] - m1[i0]) * pFrac;
    return a + (b - a) * fFrac;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    const right = out.length > 1 ? out[1] : null;
    const n = left.length;
    left.fill(0);
    if (right) right.fill(0);

    if (!this.table) return true;

    const sr = sampleRate;
    const aInc = 1 / (Math.max(0.001, this.adsr.a) * sr);
    const dInc = 1 / (Math.max(0.001, this.adsr.d) * sr);
    const rInc = 1 / (Math.max(0.001, this.adsr.r) * sr);
    const sustain = this.adsr.s;

    for (const v of this.voices) {
      if (!v.active) continue;

      // mip 選択: 再生周波数で許容 harmonic を決める
      const kMax = Math.max(1, Math.floor(sr / (2 * v.freq)));
      const baseMax = this.table.frameLen >> 1;
      let mip = 0;
      while (mip < MIPS - 1 && baseMax >> mip > kMax) mip++;

      const inc = v.freq / sr;

      for (let i = 0; i < n; i++) {
        // envelope
        if (v.stage === "attack") {
          v.env += aInc;
          if (v.env >= 1) {
            v.env = 1;
            v.stage = "decay";
          }
        } else if (v.stage === "decay") {
          v.env -= dInc;
          if (v.env <= sustain) {
            v.env = sustain;
            v.stage = "sustain";
          }
        } else if (v.stage === "release") {
          v.env -= rInc;
          if (v.env <= 0) {
            v.env = 0;
            v.active = false;
            v.stage = "off";
            break;
          }
        }

        const s =
          this.sampleTable(mip, this.wtPos, v.phase) * v.env * v.velocity * 0.3;
        left[i] += s;
        if (right) right[i] += s;

        v.phase += inc;
        if (v.phase >= 1) v.phase -= 1;
      }
    }

    return true;
  }
}

registerProcessor("wavetable-synth", WavetableSynthProcessor);
