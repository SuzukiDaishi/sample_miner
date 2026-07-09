import { create } from "zustand";
import type { AssetType } from "../manifest/schema";
import type { SliceFeatures } from "../analysis/features";
import type { ExtractedWavetable } from "../analysis/wavetable-extract";
import type { LoopResult } from "../analysis/loop-search";
import type { DecodedAudio } from "../audio/decode";

export type AssetItem = {
  id: string;
  segmentId: string;
  name: string;
  startSample: number;
  endSample: number;
  onsetSample: number;
  detectionMethod: "onset" | "silence" | "manual";
  features: SliceFeatures;
  type: AssetType;
  confidence: number;
  userEdited: boolean;
  rootMidi?: number;
};

export type WavetableItem = ExtractedWavetable & {
  id: string;
  sourceAssetId?: string;
  generatedFrom: { startSec: number; endSec: number };
};

export type DroneLoopItem = {
  id: string;
  name: string;
  sourceAssetId?: string;
  /** source mono 全体に対する絶対サンプル位置 */
  loop: LoopResult;
  buffer: Float32Array;
  sampleRate: number;
};

export type DrumLane = {
  assetId: string | null;
  steps: boolean[]; // 16 steps / bar (全 bar 共通パターン)
};

export type MelodyLane = {
  assetId: string | null;
  /** step ごとの semitone offset。null = 休符 */
  steps: (number | null)[];
};

export type ArrangementState = {
  bpm: number;
  bars: number;
  drumLanes: DrumLane[];
  droneId: string | null;
  droneGainDb: number;
  melodyLane: MelodyLane;
  phraseLane: DrumLane;
};

export type Region = { startSample: number; endSample: number };

export type AnalysisStatus =
  | { state: "idle" }
  | { state: "analyzing"; stage: string; done: number; total: number }
  | { state: "done" }
  | { state: "error"; message: string };

export const STEPS_PER_BAR = 16;

function emptyArrangement(): ArrangementState {
  return {
    bpm: 120,
    bars: 4,
    drumLanes: Array.from({ length: 4 }, () => ({
      assetId: null,
      steps: Array(STEPS_PER_BAR).fill(false),
    })),
    droneId: null,
    droneGainDb: -8,
    melodyLane: { assetId: null, steps: Array(STEPS_PER_BAR).fill(null) },
    phraseLane: { assetId: null, steps: Array(STEPS_PER_BAR).fill(false) },
  };
}

export type MinerState = {
  projectName: string;
  sourceName: string | null;
  sourceFile: File | null;
  decoded: DecodedAudio | null;
  mono: Float32Array | null;

  analysisStatus: AnalysisStatus;
  onsets: number[];
  assets: AssetItem[];

  selectedAssetId: string | null;
  region: Region | null;

  wavetables: WavetableItem[];
  activeWavetableId: string | null;

  drones: DroneLoopItem[];
  activeDroneId: string | null;

  arrangement: ArrangementState;

  // actions
  setSource: (
    name: string,
    decoded: DecodedAudio,
    mono: Float32Array,
    file: File | null
  ) => void;
  setAnalysisStatus: (s: AnalysisStatus) => void;
  setAnalysisResult: (onsets: number[], assets: AssetItem[]) => void;
  selectAsset: (id: string | null) => void;
  setRegion: (r: Region | null) => void;
  updateAsset: (id: string, patch: Partial<AssetItem>) => void;
  addWavetable: (wt: WavetableItem) => void;
  setActiveWavetable: (id: string | null) => void;
  addDrone: (d: DroneLoopItem) => void;
  setActiveDrone: (id: string | null) => void;
  setArrangement: (patch: Partial<ArrangementState>) => void;
  updateDrumLane: (index: number, patch: Partial<DrumLane>) => void;
  updateMelodyLane: (patch: Partial<MelodyLane>) => void;
  updatePhraseLane: (patch: Partial<DrumLane>) => void;
  reset: () => void;
};

export const useMinerStore = create<MinerState>((set) => ({
  projectName: "sample_miner_project",
  sourceName: null,
  sourceFile: null,
  decoded: null,
  mono: null,

  analysisStatus: { state: "idle" },
  onsets: [],
  assets: [],

  selectedAssetId: null,
  region: null,

  wavetables: [],
  activeWavetableId: null,

  drones: [],
  activeDroneId: null,

  arrangement: emptyArrangement(),

  setSource: (name, decoded, mono, file) =>
    set({
      sourceName: name,
      sourceFile: file,
      projectName: name.replace(/\.[^.]+$/, ""),
      decoded,
      mono,
      assets: [],
      onsets: [],
      selectedAssetId: null,
      region: null,
      wavetables: [],
      activeWavetableId: null,
      drones: [],
      activeDroneId: null,
      arrangement: emptyArrangement(),
      analysisStatus: { state: "idle" },
    }),

  setAnalysisStatus: (analysisStatus) => set({ analysisStatus }),

  setAnalysisResult: (onsets, assets) =>
    set({ onsets, assets, analysisStatus: { state: "done" } }),

  selectAsset: (selectedAssetId) => set({ selectedAssetId }),

  setRegion: (region) => set({ region }),

  updateAsset: (id, patch) =>
    set((s) => ({
      assets: s.assets.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    })),

  addWavetable: (wt) =>
    set((s) => ({
      wavetables: [...s.wavetables, wt],
      activeWavetableId: wt.id,
    })),

  setActiveWavetable: (activeWavetableId) => set({ activeWavetableId }),

  addDrone: (d) =>
    set((s) => ({ drones: [...s.drones, d], activeDroneId: d.id })),

  setActiveDrone: (activeDroneId) => set({ activeDroneId }),

  setArrangement: (patch) =>
    set((s) => ({ arrangement: { ...s.arrangement, ...patch } })),

  updateDrumLane: (index, patch) =>
    set((s) => ({
      arrangement: {
        ...s.arrangement,
        drumLanes: s.arrangement.drumLanes.map((l, i) =>
          i === index ? { ...l, ...patch } : l
        ),
      },
    })),

  updateMelodyLane: (patch) =>
    set((s) => ({
      arrangement: {
        ...s.arrangement,
        melodyLane: { ...s.arrangement.melodyLane, ...patch },
      },
    })),

  updatePhraseLane: (patch) =>
    set((s) => ({
      arrangement: {
        ...s.arrangement,
        phraseLane: { ...s.arrangement.phraseLane, ...patch },
      },
    })),

  reset: () =>
    set({
      sourceName: null,
      sourceFile: null,
      decoded: null,
      mono: null,
      analysisStatus: { state: "idle" },
      onsets: [],
      assets: [],
      selectedAssetId: null,
      region: null,
      wavetables: [],
      activeWavetableId: null,
      drones: [],
      activeDroneId: null,
      arrangement: emptyArrangement(),
    }),
}));
