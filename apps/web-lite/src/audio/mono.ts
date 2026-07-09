/** 解析用 mono buffer 生成。docs 02 のコード例準拠。 */

export function toMono(channels: Float32Array[]): Float32Array {
  const n = channels[0].length;
  const out = new Float32Array(n);

  for (const ch of channels) {
    for (let i = 0; i < n; i++) {
      out[i] += ch[i] / channels.length;
    }
  }

  return out;
}
