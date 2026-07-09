/**
 * .zwt export。docs 05 の形式案: JSON + f32 binary の 2 ファイル。
 *   name.zwt.json / name.zwt.f32
 */
import type { ExtractedWavetable } from "../analysis/wavetable-extract";

export type ZwtFiles = {
  jsonName: string;
  jsonBytes: Uint8Array;
  binName: string;
  binBytes: Uint8Array;
};

export function exportZwt(
  wt: ExtractedWavetable,
  sourceAssetId?: string
): ZwtFiles {
  const safeName = wt.name.replace(/[^\w\-]+/g, "_");
  const binName = `${safeName}.zwt.f32`;

  const json = {
    version: 1,
    name: safeName,
    frameLen: wt.frameLen,
    frames: wt.frames,
    sampleFormat: "f32le",
    rootMidi: wt.rootNote,
    sourceAssetId: sourceAssetId ?? null,
    binaryPath: binName,
  };

  const binBytes = new Uint8Array(wt.samples.length * 4);
  new DataView(binBytes.buffer);
  const view = new DataView(binBytes.buffer);
  for (let i = 0; i < wt.samples.length; i++) {
    view.setFloat32(i * 4, wt.samples[i], true);
  }

  return {
    jsonName: `${safeName}.zwt.json`,
    jsonBytes: new TextEncoder().encode(JSON.stringify(json, null, 2)),
    binName,
    binBytes,
  };
}
