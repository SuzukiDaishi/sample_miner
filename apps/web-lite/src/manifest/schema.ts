/**
 * 共通データモデル / manifest schema。
 * docs/ai_sample_miner_design_docs/05_data_model_and_manifest.md 準拠。
 * Web Lite 版 / Full 版で処理エンジンが違っても manifest 形式は共通にする。
 */

export type ProjectManifest = {
  version: "0.1";
  projectId: string;
  name: string;
  createdAt: string;

  sources: AudioSource[];
  derivedTracks: DerivedTrack[];
  segments: Segment[];
  assets: AudioAsset[];
  arrangements: Arrangement[];
};

export type AudioSource = {
  id: string;
  originalName: string;
  originalPath?: string;
  masterPath?: string;

  durationSec: number;
  sampleRate: number;
  channels: number;

  contentHash?: string;
};

export type TrackKind =
  | "Original"
  | "DemucsDrums"
  | "DemucsBass"
  | "DemucsVocals"
  | "DemucsOther"
  | "AudioSepQuery"
  | "HPSSHarmonic"
  | "HPSSPercussive"
  | "Manual";

export type DerivedTrack = {
  id: string;
  sourceId: string;
  kind: TrackKind;
  queryText?: string;

  wavPath?: string;

  modelName?: string;
  modelVersion?: string;
  confidence?: number;
};

export type DetectionMethod =
  | "onset"
  | "silence"
  | "manual"
  | "pitch_stable"
  | "loop_candidate"
  | "ai";

export type Segment = {
  id: string;
  trackId: string;

  startSec: number;
  endSec: number;
  startSample?: number;
  endSample?: number;

  detectionMethod: DetectionMethod;

  confidence: number;
  features: AudioFeatures;
};

export type AssetType =
  | "PercussiveOneShot"
  | "MelodicOneShot"
  | "BassOneShot"
  | "Impact"
  | "WavetableCandidate"
  | "Wavetable"
  | "DroneLoop"
  | "NoiseTexture"
  | "AmbienceLoop"
  | "MelodicPhrase"
  | "VocalChop"
  | "SliceLoop"
  | "Reject";

export type AudioAsset = {
  id: string;
  segmentId: string;

  type: AssetType;
  tags: string[];

  renderedPath?: string;

  rootNote?: string;
  rootMidi?: number;
  pitchHz?: number;

  bpm?: number;
  key?: string;

  loop?: LoopPoints;
  wavetable?: WavetableInfo;
  midi?: MidiInfo;

  confidence: number;
  uncertain?: boolean;
  userEdited?: boolean;
};

export type AudioFeatures = {
  durationSec: number;

  rmsDb: number;
  peakDb: number;

  attackMs?: number;
  decayMs?: number;
  transientDensity?: number;

  spectralCentroidMean?: number;
  spectralCentroidStd?: number;
  spectralFlatnessMean?: number;
  zeroCrossingRateMean?: number;

  mfccMean?: number[];
  mfccStd?: number[];

  f0MedianHz?: number;
  f0Confidence?: number;
  f0StabilityCents?: number;
  voicedRatio?: number;

  harmonicRatio?: number;
  percussiveRatio?: number;

  bpm?: number;
  key?: string;

  clapTags?: ScoredTag[];
  eventTags?: ScoredTag[];
};

export type ScoredTag = {
  tag: string;
  score: number;
  source: "rule" | "clap" | "yamnet" | "panns" | "manual";
};

export type LoopPoints = {
  enabled: boolean;

  startSec: number;
  endSec: number;

  startSample?: number;
  endSample?: number;

  crossfadeMs: number;
  score: number;

  method: "manual" | "auto_waveform" | "auto_spectral" | "auto_mfcc";
};

export type WavetableInfo = {
  path?: string;

  frameLen: 2048;
  frames: number; // initial: 8
  sampleFormat: "f32le";

  rootNote?: string;
  rootMidi?: number;
  sourcePitchHz?: number;

  generatedFrom: {
    segmentId: string;
    startSec: number;
    endSec: number;
    method: "manual_region" | "pitch_stable_region" | "ai_candidate";
  };

  quality: {
    pitchConfidence: number;
    pitchStabilityCents: number;
    periodicity: number;
    noiseAmount?: number;
  };
};

export type MidiInfo = {
  path: string;
  confidence: number;
  noteCount: number;
  method: "basic_pitch" | "manual" | "simple_pitch";
};

export type Arrangement = {
  id: string;
  name: string;

  bpm: number;
  bars: number;
  beatsPerBar: number;

  tracks: ArrangementTrack[];
};

export type ArrangementTrack = {
  id: string;
  type: "drums" | "drone" | "melody" | "phrase" | "bass";
  events: ArrangementEvent[];
};

export type ArrangementEvent = {
  assetId: string;
  startBeat: number;
  durationBeat?: number;
  gainDb?: number;
  pitchSemitone?: number;
  pan?: number;
};
