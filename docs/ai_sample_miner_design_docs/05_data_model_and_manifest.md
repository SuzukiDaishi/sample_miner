# 05. データモデルとmanifest

## 方針

Web Lite版とFull版で、処理エンジンは違っても **manifest形式は共通** にする。

これにより、

```text
Web Liteで軽く解析
  ↓
manifest保存
  ↓
Full版で再解析
  ↓
同じUIで編集
```

ができる。

## Project

```ts
type ProjectManifest = {
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
```

## AudioSource

入力ファイル。

```ts
type AudioSource = {
  id: string;
  originalName: string;
  originalPath?: string;
  masterPath?: string;

  durationSec: number;
  sampleRate: number;
  channels: number;

  contentHash?: string;
};
```

## DerivedTrack

分離やHPSSで生まれた派生トラック。

```ts
type TrackKind =
  | "Original"
  | "DemucsDrums"
  | "DemucsBass"
  | "DemucsVocals"
  | "DemucsOther"
  | "AudioSepQuery"
  | "HPSSHarmonic"
  | "HPSSPercussive"
  | "Manual";

type DerivedTrack = {
  id: string;
  sourceId: string;
  kind: TrackKind;
  queryText?: string;

  wavPath?: string;

  modelName?: string;
  modelVersion?: string;
  confidence?: number;
};
```

## Segment

非破壊の解析区間。

```ts
type Segment = {
  id: string;
  trackId: string;

  startSec: number;
  endSec: number;
  startSample?: number;
  endSample?: number;

  detectionMethod:
    | "onset"
    | "silence"
    | "manual"
    | "pitch_stable"
    | "loop_candidate"
    | "ai";

  confidence: number;
  features: AudioFeatures;
};
```

## AssetType

```ts
type AssetType =
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
```

## AudioAsset

実際に使える素材。

```ts
type AudioAsset = {
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
  userRating?: "keep" | "discard"; // 個人 ranker の教師データ (docs 08 §3.4 D-2)
};
```

## AudioFeatures

```ts
type AudioFeatures = {
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

  // キャッチーさ代理特徴 (docs 08, additive)
  presenceRatio?: number;       // 2–5kHz エネルギー比
  crestDb?: number;             // peak − RMS (dB)
  spectralFluxMean?: number;    // ピーク正規化後の onset strength 平均
  pitchRangeSemitones?: number; // voiced f0 の 10–90 percentile 幅 (半音)
  hookScore?: number;           // 原曲反復マップ上の 0..1 (docs 08 §3.2)
  clapCatchy?: number;          // CLAP 対照ペアスコア 0..1 (docs 08 §3.3)
  aesScore?: number;            // Audiobox-Aesthetics CE+PQ 正規化 0..1 (docs 08 §3.4)
  personalScore?: number;       // 個人 ranker スコア 0..1 (docs 08 §3.4)

  bpm?: number;
  key?: string;

  clapTags?: ScoredTag[];
  eventTags?: ScoredTag[];
};
```

## ScoredTag

```ts
type ScoredTag = {
  tag: string;
  score: number;
  source: "rule" | "clap" | "yamnet" | "panns" | "manual";
};
```

## LoopPoints

```ts
type LoopPoints = {
  enabled: boolean;

  startSec: number;
  endSec: number;

  startSample?: number;
  endSample?: number;

  crossfadeMs: number;
  score: number;

  method: "manual" | "auto_waveform" | "auto_spectral" | "auto_mfcc";
};
```

## WavetableInfo

既存WebCLAP synthに合わせた形式。

```ts
type WavetableInfo = {
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
```

## MidiInfo

```ts
type MidiInfo = {
  path: string;
  confidence: number;
  noteCount: number;
  method: "basic_pitch" | "manual" | "simple_pitch";
};
```

## Arrangement

簡易loop builder用。

```ts
type Arrangement = {
  id: string;
  name: string;

  bpm: number;
  bars: number;
  beatsPerBar: number;

  tracks: ArrangementTrack[];
};
```

```ts
type ArrangementTrack = {
  id: string;
  type: "drums" | "drone" | "melody" | "phrase" | "bass";
  events: ArrangementEvent[];
};
```

```ts
type ArrangementEvent = {
  assetId: string;
  startBeat: number;
  durationBeat?: number;
  gainDb?: number;
  pitchSemitone?: number;
  pan?: number;
};
```

## manifest例

```json
{
  "version": "0.1",
  "projectId": "project_001",
  "name": "field_recording_test",
  "createdAt": "2026-07-09T00:00:00+09:00",
  "sources": [
    {
      "id": "src_001",
      "originalName": "water_and_bells.wav",
      "durationSec": 42.5,
      "sampleRate": 48000,
      "channels": 2
    }
  ],
  "derivedTracks": [
    {
      "id": "track_001",
      "sourceId": "src_001",
      "kind": "Original"
    }
  ],
  "segments": [
    {
      "id": "seg_001",
      "trackId": "track_001",
      "startSec": 3.24,
      "endSec": 3.82,
      "detectionMethod": "onset",
      "confidence": 0.78,
      "features": {
        "durationSec": 0.58,
        "rmsDb": -18.2,
        "peakDb": -3.1,
        "attackMs": 12.0,
        "spectralCentroidMean": 3200.0
      }
    }
  ],
  "assets": [
    {
      "id": "asset_001",
      "segmentId": "seg_001",
      "type": "PercussiveOneShot",
      "tags": ["metal", "hit"],
      "renderedPath": "one_shots/metal_hit_001.wav",
      "confidence": 0.82
    }
  ],
  "arrangements": []
}
```

## Export folder

```text
project/
  manifest.json

  source/
    original.wav

  tracks/
    original.wav
    demucs_drums.wav
    demucs_vocals.wav

  one_shots/
    perc_001.wav
    kick_001.wav
    snare_001.wav

  melodic/
    tone_C3_001.wav

  wavetables/
    wt_C3_001.zwt
    wt_C3_001.wav

  drones/
    water_loop_001.wav

  phrases/
    phrase_001.wav

  midi/
    phrase_001.mid

  arrangements/
    loop_8bar.wav
    stems/
      drums.wav
      drone.wav
      melody.wav
```

## `.zwt` 形式案

最初はJSON + binaryでよい。

```text
voice_a3.zwt.json
voice_a3.zwt.f32
```

JSON:

```json
{
  "version": 1,
  "name": "voice_a3",
  "frameLen": 2048,
  "frames": 8,
  "sampleFormat": "f32le",
  "rootMidi": 57,
  "sourceAssetId": "asset_123",
  "binaryPath": "voice_a3.zwt.f32"
}
```

将来的には単一binary container化も検討。
