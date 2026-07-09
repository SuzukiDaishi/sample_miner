/** wavetable frame 用の resample ユーティリティ。 */

export function resampleLinear(src: Float32Array, dstLen: number): Float32Array {
  const out = new Float32Array(dstLen);
  if (src.length === 0) return out;
  if (src.length === 1) {
    out.fill(src[0]);
    return out;
  }
  const scale = src.length / dstLen;
  for (let i = 0; i < dstLen; i++) {
    const pos = i * scale;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = src[Math.min(i0, src.length - 1)];
    const b = src[Math.min(i0 + 1, src.length - 1)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** 周期波形(循環)前提の Catmull-Rom cubic resample。 */
export function resampleCubicCyclic(
  src: Float32Array,
  dstLen: number
): Float32Array {
  const out = new Float32Array(dstLen);
  const n = src.length;
  if (n === 0) return out;
  if (n === 1) {
    out.fill(src[0]);
    return out;
  }
  const scale = n / dstLen;
  for (let i = 0; i < dstLen; i++) {
    const pos = i * scale;
    const i1 = Math.floor(pos) % n;
    const frac = pos - Math.floor(pos);
    const i0 = (i1 - 1 + n) % n;
    const i2 = (i1 + 1) % n;
    const i3 = (i1 + 2) % n;
    const p0 = src[i0];
    const p1 = src[i1];
    const p2 = src[i2];
    const p3 = src[i3];
    out[i] =
      p1 +
      0.5 *
        frac *
        (p2 -
          p0 +
          frac *
            (2 * p0 - 5 * p1 + 4 * p2 - p3 + frac * (3 * (p1 - p2) + p3 - p0)));
  }
  return out;
}
