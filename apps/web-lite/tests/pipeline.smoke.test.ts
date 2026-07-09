/**
 * 実データ E2E スモーク: datasets/ の wav をフルパイプラインに通す。
 * (decode → onset → chop → features → classify → wavetable → loop)
 * datasets が無い環境では skip される。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeWav } from "../src/audio/wav-encode";
import { toMono } from "../src/audio/mono";
import { detectOnsets } from "../src/analysis/onset";
import { buildSlices } from "../src/analysis/slice";
import { computeFeatures } from "../src/analysis/features";
import { classify } from "../src/analysis/classify";
import { extractWavetable } from "../src/analysis/wavetable-extract";
import { findBestLoop, renderLoop } from "../src/analysis/loop-search";

const DATASET_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../datasets/学マス"
);

function findFirstWav(): string | null {
  if (!existsSync(DATASET_DIR)) return null;
  for (const dir of readdirSync(DATASET_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const sub = join(DATASET_DIR, dir.name);
    for (const f of readdirSync(sub)) {
      if (f.toLowerCase().endsWith(".wav")) return join(sub, f);
    }
  }
  return null;
}

const wavPath = findFirstWav();

describe.skipIf(!wavPath)("real-audio pipeline smoke", () => {
  it("chops and classifies a real song excerpt", () => {
    const bytes = new Uint8Array(readFileSync(wavPath!));
    const decoded = decodeWav(bytes);
    expect(decoded.channels.length).toBeGreaterThan(0);

    // 冒頭 30 秒だけ解析(テスト時間の上限)
    const sr = decoded.sampleRate;
    const excerptLen = Math.min(decoded.channels[0].length, sr * 30);
    const channels = decoded.channels.map((ch) => ch.subarray(0, excerptLen));
    const mono = toMono(channels as Float32Array[]);

    const onsets = detectOnsets(mono, sr);
    expect(onsets.length).toBeGreaterThan(3);

    const slices = buildSlices(mono, sr, onsets);
    expect(slices.length).toBeGreaterThan(3);

    let classified = 0;
    for (const s of slices.slice(0, 12)) {
      const f = computeFeatures(mono.subarray(s.startSample, s.endSample), sr);
      const type = classify(f);
      expect(type).toBeTruthy();
      classified++;
    }
    expect(classified).toBeGreaterThan(0);
  }, 120000);

  it("extracts a wavetable or fails gracefully, and finds a loop", () => {
    const bytes = new Uint8Array(readFileSync(wavPath!));
    const decoded = decodeWav(bytes);
    const sr = decoded.sampleRate;
    // 曲中盤の 5 秒(イントロより音が安定していることが多い)
    const mid = Math.floor(decoded.channels[0].length / 2);
    const channels = decoded.channels.map((ch) => ch.subarray(mid, mid + sr * 5));
    const mono = toMono(channels as Float32Array[]);

    // wavetable: 実曲はポリフォニックなので失敗も正常系(WavetableExtractError)
    try {
      const wt = extractWavetable(mono, sr, "smoke");
      expect(wt.samples.length).toBe(8 * 2048);
      expect(wt.rootNote).toBeGreaterThan(0);
      expect(wt.rootNote).toBeLessThan(128);
    } catch (e) {
      expect((e as Error).message).toContain("区間");
    }

    const loop = findBestLoop(mono, sr, 0.3);
    expect(loop).not.toBeNull();
    const rendered = renderLoop(mono, sr, loop!);
    expect(rendered.length).toBe(loop!.endSample - loop!.startSample);
  }, 120000);
});
