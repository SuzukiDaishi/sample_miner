/**
 * 内蔵プレビューシンセの main-thread ラッパー。
 * wavetable のロードは ZWTL packet 経由(将来 WebCLAP synth へ差し替え可能)。
 */
import workletUrl from "./wavetable-synth.worklet.js?url";
import { getAudioContext } from "../audio/decode";
import { encodeLoadTablePacket } from "./zwtl";
import type { ExtractedWavetable } from "../analysis/wavetable-extract";

export class PreviewSynth {
  private node: AudioWorkletNode | null = null;
  private loadingPromise: Promise<void> | null = null;
  loadedRootNote: number | null = null;

  async ensureStarted(): Promise<void> {
    if (this.node) return;
    if (!this.loadingPromise) {
      this.loadingPromise = (async () => {
        const ctx = getAudioContext();
        await ctx.resume();
        await ctx.audioWorklet.addModule(workletUrl);
        const node = new AudioWorkletNode(ctx, "wavetable-synth", {
          numberOfInputs: 0,
          outputChannelCount: [2],
        });
        node.connect(ctx.destination);
        node.port.onmessage = (e) => {
          if (e.data?.type === "loaded") {
            this.loadedRootNote = e.data.rootNote;
          }
        };
        this.node = node;
      })();
    }
    await this.loadingPromise;
  }

  async loadWavetable(wt: ExtractedWavetable, slot = 0): Promise<void> {
    await this.ensureStarted();
    const packet = encodeLoadTablePacket({
      slot,
      rootNote: wt.rootNote,
      frameCount: wt.frames,
      frameLen: wt.frameLen,
      samples: wt.samples,
    });
    // ArrayBuffer を transfer して worklet 側で parse させる
    const buf = packet.buffer;
    this.node!.port.postMessage({ type: "zwtl", bytes: buf }, [buf]);
  }

  noteOn(key: number, velocity = 1): void {
    this.node?.port.postMessage({ type: "noteOn", key, velocity });
  }

  noteOff(key: number): void {
    this.node?.port.postMessage({ type: "noteOff", key });
  }

  setWtPos(value: number): void {
    this.node?.port.postMessage({ type: "wtPos", value });
  }

  allNotesOff(): void {
    this.node?.port.postMessage({ type: "allNotesOff" });
  }
}

export const previewSynth = new PreviewSynth();
