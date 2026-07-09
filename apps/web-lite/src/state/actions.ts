/**
 * UI から呼ぶ高レベル操作。store / worker / DSP / synth をつなぐ。
 */
import { decodeFile } from "../audio/decode";
import { toMono } from "../audio/mono";
import { useMinerStore, type AssetItem, type WavetableItem, type DroneLoopItem } from "./store";
import type {
  AnalyzeResponse,
  AnalyzeProgress,
  AnalyzedSlice,
} from "../worker/analysis.worker";
import type { AssetType } from "../manifest/schema";
import { hzToMidi, midiToNoteName } from "../analysis/yin";
import {
  extractWavetable,
  WavetableExtractError,
} from "../analysis/wavetable-extract";
import { findBestLoop, renderLoop } from "../analysis/loop-search";
import { previewSynth } from "../synth/synth";
import { exportProjectZip, downloadBytes, sanitizeName } from "../manifest/export";
import { encodeWav } from "../audio/wav-encode";
import { bufferFromChannels, playBuffer } from "../audio/playback";

const TYPE_PREFIX: Record<AssetType, string> = {
  PercussiveOneShot: "perc",
  MelodicOneShot: "tone",
  BassOneShot: "bass",
  Impact: "impact",
  WavetableCandidate: "wtcand",
  Wavetable: "wt",
  DroneLoop: "drone",
  NoiseTexture: "noise",
  AmbienceLoop: "amb",
  MelodicPhrase: "phrase",
  VocalChop: "vocal",
  SliceLoop: "sliceloop",
  Reject: "reject",
};

function slicesToAssets(slices: AnalyzedSlice[]): AssetItem[] {
  const typeCounts = new Map<string, number>();
  return slices.map((s, i) => {
    const prefix = TYPE_PREFIX[s.assetType];
    const count = (typeCounts.get(prefix) ?? 0) + 1;
    typeCounts.set(prefix, count);

    const rootMidi =
      s.features.pitchHz !== undefined
        ? Math.round(hzToMidi(s.features.pitchHz))
        : undefined;
    const noteSuffix =
      rootMidi !== undefined &&
      (s.assetType === "MelodicOneShot" || s.assetType === "WavetableCandidate")
        ? `_${midiToNoteName(rootMidi)}`
        : "";

    return {
      id: `asset_${String(i + 1).padStart(3, "0")}`,
      segmentId: `seg_${String(i + 1).padStart(3, "0")}`,
      name: `${prefix}${noteSuffix}_${String(count).padStart(3, "0")}`,
      startSample: s.startSample,
      endSample: s.endSample,
      onsetSample: s.onsetSample,
      detectionMethod: "onset",
      features: s.features,
      type: s.assetType,
      confidence: s.confidence,
      userEdited: false,
      rootMidi,
    };
  });
}

let worker: Worker | null = null;

export function runAnalysis(manualOnsets?: number[]): void {
  const { mono, decoded, setAnalysisStatus, setAnalysisResult } =
    useMinerStore.getState();
  if (!mono || !decoded) return;

  if (worker) worker.terminate();
  worker = new Worker(new URL("../worker/analysis.worker.ts", import.meta.url), {
    type: "module",
  });

  worker.onmessage = (
    e: MessageEvent<AnalyzeResponse | AnalyzeProgress>
  ) => {
    const msg = e.data;
    if (msg.type === "progress") {
      setAnalysisStatus({
        state: "analyzing",
        stage: msg.stage,
        done: msg.done,
        total: msg.total,
      });
    } else if (msg.type === "result") {
      setAnalysisResult(msg.onsets, slicesToAssets(msg.slices));
    }
  };
  worker.onerror = (e) => {
    setAnalysisStatus({ state: "error", message: e.message });
  };

  setAnalysisStatus({ state: "analyzing", stage: "onset", done: 0, total: 1 });

  // mono は store 側でも使うので transfer 用にコピーを送る
  const copy = mono.slice();
  worker.postMessage(
    { type: "analyze", mono: copy, sampleRate: decoded.sampleRate, manualOnsets },
    [copy.buffer]
  );
}

export async function loadFile(file: File): Promise<void> {
  const { setSource, setAnalysisStatus } = useMinerStore.getState();
  try {
    const decoded = await decodeFile(file);
    const mono = toMono(decoded.channels);
    setSource(file.name, decoded, mono, file);
    runAnalysis();
  } catch (err) {
    setAnalysisStatus({
      state: "error",
      message: `decode failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

export function addManualOnset(sample: number): void {
  const { onsets } = useMinerStore.getState();
  const merged = [...onsets, Math.round(sample)].sort((a, b) => a - b);
  runAnalysis(merged);
}

export function removeOnset(sample: number, toleranceSamples: number): void {
  const { onsets } = useMinerStore.getState();
  let bestIdx = -1;
  let bestDist = Infinity;
  onsets.forEach((o, i) => {
    const d = Math.abs(o - sample);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  });
  if (bestIdx < 0 || bestDist > toleranceSamples) return;
  runAnalysis(onsets.filter((_, i) => i !== bestIdx));
}

export function playAsset(assetId: string): void {
  const { assets, decoded } = useMinerStore.getState();
  const asset = assets.find((a) => a.id === assetId);
  if (!asset || !decoded) return;
  const buf = bufferFromChannels(
    decoded.channels,
    decoded.sampleRate,
    asset.startSample,
    asset.endSample
  );
  playBuffer(buf);
}

export function playRegion(): void {
  const { region, decoded } = useMinerStore.getState();
  if (!region || !decoded) return;
  const buf = bufferFromChannels(
    decoded.channels,
    decoded.sampleRate,
    region.startSample,
    region.endSample
  );
  playBuffer(buf);
}

/**
 * region(あれば)または選択 asset の範囲から wavetable を抽出し、
 * 内蔵シンセへロードする。
 */
export async function extractWavetableFromSelection(): Promise<string | null> {
  const state = useMinerStore.getState();
  const { mono, decoded } = state;
  if (!mono || !decoded) return "音声が読み込まれていません";

  let start: number;
  let end: number;
  let sourceAssetId: string | undefined;

  if (state.region) {
    start = state.region.startSample;
    end = state.region.endSample;
  } else if (state.selectedAssetId) {
    const asset = state.assets.find((a) => a.id === state.selectedAssetId);
    if (!asset) return "選択された素材がありません";
    start = asset.startSample;
    end = asset.endSample;
    sourceAssetId = asset.id;
  } else {
    return "波形上で region を選択するか、素材を選択してください";
  }

  try {
    const region = mono.subarray(start, end);
    const idx = state.wavetables.length + 1;
    const wt = extractWavetable(region, decoded.sampleRate, "wt");
    const name = `wt_${midiToNoteName(wt.rootNote)}_${String(idx).padStart(3, "0")}`;
    const item: WavetableItem = {
      ...wt,
      name,
      id: `wt_${String(idx).padStart(3, "0")}`,
      sourceAssetId,
      generatedFrom: {
        startSec: start / decoded.sampleRate,
        endSec: end / decoded.sampleRate,
      },
    };
    state.addWavetable(item);
    await previewSynth.loadWavetable(item);
    return null;
  } catch (err) {
    if (err instanceof WavetableExtractError) return err.message;
    throw err;
  }
}

export async function sendWavetableToSynth(id: string): Promise<void> {
  const { wavetables, setActiveWavetable } = useMinerStore.getState();
  const wt = wavetables.find((w) => w.id === id);
  if (!wt) return;
  setActiveWavetable(id);
  await previewSynth.loadWavetable(wt);
}

/** region または選択 asset から drone loop を生成する。 */
export function makeDroneLoop(): string | null {
  const state = useMinerStore.getState();
  const { mono, decoded } = state;
  if (!mono || !decoded) return "音声が読み込まれていません";

  let start: number;
  let end: number;
  let sourceAssetId: string | undefined;
  let flatness = 0.2;

  if (state.region) {
    start = state.region.startSample;
    end = state.region.endSample;
  } else if (state.selectedAssetId) {
    const asset = state.assets.find((a) => a.id === state.selectedAssetId);
    if (!asset) return "選択された素材がありません";
    start = asset.startSample;
    end = asset.endSample;
    sourceAssetId = asset.id;
    flatness = asset.features.spectralFlatness;
  } else {
    return "波形上で region を選択するか、素材を選択してください";
  }

  const seg = mono.subarray(start, end);
  if (seg.length < decoded.sampleRate * 1.5) {
    return "loop 生成には 1.5 秒以上の区間が必要です";
  }

  const loop = findBestLoop(seg, decoded.sampleRate, flatness);
  if (!loop) return "loop point が見つかりませんでした";

  // seg 内相対 → mono 絶対位置へ
  const absLoop = {
    ...loop,
    startSample: loop.startSample + start,
    endSample: loop.endSample + start,
  };
  const buffer = renderLoop(mono, decoded.sampleRate, absLoop);

  const idx = state.drones.length + 1;
  const item: DroneLoopItem = {
    id: `drone_${String(idx).padStart(3, "0")}`,
    name: `drone_loop_${String(idx).padStart(3, "0")}`,
    sourceAssetId,
    loop: absLoop,
    buffer,
    sampleRate: decoded.sampleRate,
  };
  state.addDrone(item);
  return null;
}

export function playDrone(id: string): void {
  const { drones } = useMinerStore.getState();
  const d = drones.find((x) => x.id === id);
  if (!d) return;
  const buf = bufferFromChannels([d.buffer], d.sampleRate);
  playBuffer(buf, { loop: true });
}

export function exportAssetWav(assetId: string): void {
  const { assets, decoded } = useMinerStore.getState();
  const asset = assets.find((a) => a.id === assetId);
  if (!asset || !decoded) return;
  const chans = decoded.channels.map((ch) =>
    ch.subarray(asset.startSample, asset.endSample)
  );
  const bytes = encodeWav(chans as Float32Array[], decoded.sampleRate, 16);
  downloadBytes(bytes, `${sanitizeName(asset.name)}.wav`, "audio/wav");
}

export function exportAllZip(): void {
  const s = useMinerStore.getState();
  const zip = exportProjectZip({
    projectName: s.projectName,
    sourceName: s.sourceName,
    decoded: s.decoded,
    assets: s.assets,
    wavetables: s.wavetables,
    drones: s.drones,
    arrangement: s.arrangement,
  });
  downloadBytes(zip, `${sanitizeName(s.projectName)}_mined.zip`, "application/zip");
}
