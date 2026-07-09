/**
 * ZWTL packet: UI → synth への wavetable ロード protocol。
 * docs 04 準拠:
 *   magic "ZWTL" (4) | slot u8 | frameCount u8 | frameLen u16le |
 *   rootNote u8 | reserved u8*3 | samples f32le * (frameCount*frameLen)
 * 内蔵プレビューシンセへのロードもこの packet を経由させ、
 * 将来 z-audio-webclap-wavetable へ差し替え可能にする。
 */

export type LoadTablePacket = {
  slot: number;
  frameCount: number;
  frameLen: number;
  rootNote: number;
  samples: Float32Array;
};

const HEADER_SIZE = 12;

export function encodeLoadTablePacket(wt: {
  slot: number;
  rootNote: number;
  frameCount: number;
  frameLen: number;
  samples: Float32Array;
}): Uint8Array {
  const sampleBytes = wt.samples.length * 4;
  const bytes = new Uint8Array(HEADER_SIZE + sampleBytes);
  const view = new DataView(bytes.buffer);

  bytes[0] = "Z".charCodeAt(0);
  bytes[1] = "W".charCodeAt(0);
  bytes[2] = "T".charCodeAt(0);
  bytes[3] = "L".charCodeAt(0);

  view.setUint8(4, wt.slot);
  view.setUint8(5, wt.frameCount);
  view.setUint16(6, wt.frameLen, true);
  view.setUint8(8, wt.rootNote);
  // bytes 9..11 reserved = 0

  let offset = HEADER_SIZE;
  for (const s of wt.samples) {
    view.setFloat32(offset, s, true);
    offset += 4;
  }

  return bytes;
}

export function parseLoadTablePacket(bytes: Uint8Array): LoadTablePacket | null {
  if (
    bytes.length < HEADER_SIZE ||
    bytes[0] !== 0x5a || // Z
    bytes[1] !== 0x57 || // W
    bytes[2] !== 0x54 || // T
    bytes[3] !== 0x4c //    L
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const slot = view.getUint8(4);
  const frameCount = view.getUint8(5);
  const frameLen = view.getUint16(6, true);
  const rootNote = view.getUint8(8);

  const sampleCount = frameCount * frameLen;
  const expected = HEADER_SIZE + sampleCount * 4;
  if (bytes.length !== expected) return null;

  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = view.getFloat32(HEADER_SIZE + i * 4, true);
  }

  return { slot, frameCount, frameLen, rootNote, samples };
}
