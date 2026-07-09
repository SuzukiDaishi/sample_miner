import { magnitudeSpectrum } from "./fft";

export function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  return w;
}

export type StftResult = {
  /** frames[i] = i 番目のフレームの magnitude spectrum (fftSize/2+1 bins) */
  frames: Float32Array[];
  fftSize: number;
  hopSize: number;
};

/** Hann 窓 STFT の magnitude spectrogram を計算する。 */
export function stftMagnitudes(
  mono: Float32Array,
  fftSize: number,
  hopSize: number
): StftResult {
  const window = hannWindow(fftSize);
  const frames: Float32Array[] = [];
  const buf = new Float32Array(fftSize);

  for (let start = 0; start + fftSize <= mono.length; start += hopSize) {
    for (let i = 0; i < fftSize; i++) {
      buf[i] = mono[start + i] * window[i];
    }
    frames.push(magnitudeSpectrum(buf));
  }

  return { frames, fftSize, hopSize };
}
