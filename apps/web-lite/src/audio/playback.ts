/** slice / loop の簡易プレビュー再生。 */
import { getAudioContext } from "./decode";

let currentSource: AudioBufferSourceNode | null = null;

export function stopPlayback(): void {
  if (currentSource) {
    try {
      currentSource.stop();
    } catch {
      // already stopped
    }
    currentSource = null;
  }
}

export function bufferFromChannels(
  channels: Float32Array[],
  sampleRate: number,
  startSample = 0,
  endSample?: number
): AudioBuffer {
  const ctx = getAudioContext();
  const end = endSample ?? channels[0].length;
  const len = Math.max(1, end - startSample);
  const buf = ctx.createBuffer(channels.length, len, sampleRate);
  for (let ch = 0; ch < channels.length; ch++) {
    buf.copyToChannel(
      channels[ch].subarray(startSample, end) as Float32Array<ArrayBuffer>,
      ch
    );
  }
  return buf;
}

export function playBuffer(
  buffer: AudioBuffer,
  options: { loop?: boolean; playbackRate?: number; gainDb?: number } = {}
): void {
  const ctx = getAudioContext();
  void ctx.resume();
  stopPlayback();

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = options.loop ?? false;
  src.playbackRate.value = options.playbackRate ?? 1;

  const gain = ctx.createGain();
  gain.gain.value = Math.pow(10, (options.gainDb ?? 0) / 20);

  src.connect(gain).connect(ctx.destination);
  src.onended = () => {
    if (currentSource === src) currentSource = null;
  };
  src.start();
  currentSource = src;
}

export function isPlaying(): boolean {
  return currentSource !== null;
}
