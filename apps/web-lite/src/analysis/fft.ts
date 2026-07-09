/**
 * 依存なしの iterative radix-2 complex FFT。
 * STFT / wavetable phase align / mip 生成で共用する。
 */

/** in-place complex FFT。re/im の長さは 2 の冪であること。 */
export function fftComplex(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  if (n !== im.length || (n & (n - 1)) !== 0) {
    throw new Error(`fftComplex: length must be power of 2, got ${n}`);
  }

  // bit-reversal permutation
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
    const ang = (-2 * Math.PI) / len;
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
}

/** in-place inverse complex FFT(1/N 正規化込み)。 */
export function ifftComplex(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fftComplex(re, im);
  for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] = -im[i] / n;
  }
}

/** 実信号の magnitude spectrum(bin 0..N/2)を返す。 */
export function magnitudeSpectrum(frame: Float32Array): Float32Array {
  const n = frame.length;
  const re = Float32Array.from(frame);
  const im = new Float32Array(n);
  fftComplex(re, im);
  const half = n >> 1;
  const mag = new Float32Array(half + 1);
  for (let i = 0; i <= half; i++) {
    mag[i] = Math.hypot(re[i], im[i]);
  }
  return mag;
}
