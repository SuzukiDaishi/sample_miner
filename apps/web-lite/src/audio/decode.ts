/** File → AudioBuffer decode。docs 02 のコード例準拠。 */

export type DecodedAudio = {
  sampleRate: number;
  channels: Float32Array[];
  durationSec: number;
};

let sharedContext: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!sharedContext) {
    sharedContext = new AudioContext();
  }
  return sharedContext;
}

export async function decodeFile(file: File): Promise<DecodedAudio> {
  const arrayBuffer = await file.arrayBuffer();
  const audioBuffer = await getAudioContext().decodeAudioData(arrayBuffer);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    channels.push(audioBuffer.getChannelData(ch).slice());
  }

  return {
    sampleRate: audioBuffer.sampleRate,
    channels,
    durationSec: audioBuffer.duration,
  };
}
