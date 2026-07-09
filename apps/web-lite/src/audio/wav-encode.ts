/** Float32 チャンネル配列 → RIFF WAV encode(16bit PCM / 32bit float)。 */

export type WavBitDepth = 16 | 32;

export function encodeWav(
  channels: Float32Array[],
  sampleRate: number,
  bitDepth: WavBitDepth = 16
): Uint8Array {
  const numChannels = channels.length;
  const numFrames = channels[0]?.length ?? 0;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(offset + i, s.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true); // 3 = IEEE float
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const v = Math.max(-1, Math.min(1, channels[ch][i]));
      if (bitDepth === 16) {
        view.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7fff, true);
        offset += 2;
      } else {
        view.setFloat32(offset, v, true);
        offset += 4;
      }
    }
  }

  return new Uint8Array(buffer);
}

/** テスト/検証用の簡易 WAV decoder(このツールが書く形式のみ対応)。 */
export function decodeWav(bytes: Uint8Array): {
  channels: Float32Array[];
  sampleRate: number;
  bitDepth: number;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readString = (offset: number, len: number) => {
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
    return s;
  };
  if (readString(0, 4) !== "RIFF" || readString(8, 4) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }

  // chunk 走査(fmt / data 以外の LIST 等はスキップ)
  let format = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitDepth = 0;
  let dataOffset = -1;
  let dataSize = 0;
  let pos = 12;
  while (pos + 8 <= bytes.byteLength) {
    const chunkId = readString(pos, 4);
    const chunkSize = view.getUint32(pos + 4, true);
    if (chunkId === "fmt ") {
      format = view.getUint16(pos + 8, true);
      numChannels = view.getUint16(pos + 10, true);
      sampleRate = view.getUint32(pos + 12, true);
      bitDepth = view.getUint16(pos + 22, true);
    } else if (chunkId === "data") {
      dataOffset = pos + 8;
      dataSize = chunkSize;
      break;
    }
    pos += 8 + chunkSize + (chunkSize % 2);
  }
  if (dataOffset < 0 || numChannels === 0) {
    throw new Error("wav: fmt/data chunk not found");
  }
  const numFrames = Math.floor(dataSize / (numChannels * (bitDepth / 8)));

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(new Float32Array(numFrames));
  }
  let offset = dataOffset;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      if (bitDepth === 16) {
        const v = view.getInt16(offset, true);
        channels[ch][i] = v < 0 ? v / 0x8000 : v / 0x7fff;
        offset += 2;
      } else if (bitDepth === 32 && format === 3) {
        channels[ch][i] = view.getFloat32(offset, true);
        offset += 4;
      } else {
        throw new Error(`unsupported wav format: ${format}/${bitDepth}bit`);
      }
    }
  }
  return { channels, sampleRate, bitDepth };
}
