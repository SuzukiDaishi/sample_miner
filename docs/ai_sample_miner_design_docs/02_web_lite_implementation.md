# 02. Webフロントエンド軽量実装

## 目的

ブラウザだけで動作する軽量版。

重いAIモデルを使わず、DSPとルールベース分類で以下を実現する。

```text
音声ファイルD&D
  ↓
波形表示
  ↓
onset検出
  ↓
チョップ
  ↓
簡易分類
  ↓
wavetable候補 / drone候補生成
  ↓
WebCLAP wavetable synthで試奏
  ↓
zip export
```

## できること

| 機能 | 対応 |
|---|---|
| wav/mp3読み込み | 可能 |
| 波形表示 | 可能 |
| onset検出 | 可能 |
| 無音検出 | 可能 |
| 簡易分類 | 可能 |
| pitch推定 | YIN/autocorrelationで可能 |
| single-cycle wavetable | 可能 |
| drone loop | 簡易なら可能 |
| zip export | 可能 |
| WebCLAP synth連携 | 可能 |

## やらないこと

| 機能 | 理由 |
|---|---|
| Demucs分離 | ブラウザでは重い |
| AudioSep | ブラウザでは重い |
| CLAP分類 | モデルサイズ/推論コストが大きい |
| 高精度MIDI化 | Basic Pitch等が必要 |
| 長尺高精度解析 | メモリ・CPU負荷が大きい |

## アーキテクチャ

```text
React / Vite / Next.js
  ↓
Audio Decode Layer
  - Web Audio API
  - decodeAudioData
  ↓
Analysis Worker
  - Web Worker
  - optional Rust/WASM DSP
  ↓
DSP Core
  - onset
  - RMS
  - spectral features
  - YIN pitch
  - loop search
  - wavetable extraction
  ↓
Preview Engine
  - AudioBufferSourceNode
  - AudioWorklet optional
  ↓
WebCLAP Synth
  - z-audio-webclap-wavetable
  ↓
Export
  - wav
  - manifest.json
  - zip
```

## 推奨ディレクトリ構成

```text
apps/
  web-lite/
    src/
      audio/
        decode.ts
        wav-encode.ts
        resample.ts
      analysis/
        onset.ts
        features.ts
        yin.ts
        classify.ts
        loop-search.ts
        wavetable-extract.ts
      components/
        WaveformView.tsx
        SliceGrid.tsx
        AssetInspector.tsx
        WavetablePanel.tsx
        SynthPanel.tsx
      manifest/
        schema.ts
      worker/
        analysis.worker.ts
```

将来的にはDSP部分をRust/WASM化。

```text
crates/
  audio-core/
    src/
      onset.rs
      features.rs
      yin.rs
      wavetable_extract.rs
      loop_search.rs
```

## 入力処理

```ts
async function decodeFile(file: File): Promise<DecodedAudio> {
  const arrayBuffer = await file.arrayBuffer();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

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
```

解析用にはmono bufferを作る。

```ts
function toMono(channels: Float32Array[]): Float32Array {
  const n = channels[0].length;
  const out = new Float32Array(n);

  for (const ch of channels) {
    for (let i = 0; i < n; i++) {
      out[i] += ch[i] / channels.length;
    }
  }

  return out;
}
```

## onset検出

### 処理

```text
mono buffer
  ↓
STFT
  ↓
magnitude spectrum
  ↓
spectral flux
  ↓
normalize
  ↓
peak picking
  ↓
onset backtracking
```

### 推奨パラメータ

```ts
type OnsetConfig = {
  fftSize: 1024;
  hopSize: 256;
  minIntervalMs: 60;
  threshold: 1.5;
  preAverageFrames: 8;
  postAverageFrames: 8;
};
```

### peak pickingの考え方

```ts
function pickPeaks(flux: Float32Array, threshold: number): number[] {
  const peaks: number[] = [];

  for (let i = 1; i < flux.length - 1; i++) {
    const isLocalMax = flux[i] > flux[i - 1] && flux[i] >= flux[i + 1];
    if (!isLocalMax) continue;

    const localMean = localAverage(flux, i, 8);
    if (flux[i] > localMean * threshold) {
      peaks.push(i);
    }
  }

  return peaks;
}
```

## slice生成

```ts
type Slice = {
  id: string;
  startSample: number;
  endSample: number;
  onsetSample: number;
};
```

tail推定:

```text
start = onset - 5ms
end =
  min(
    next_onset - 5ms,
    point where RMS < peakRms - 40dB,
    onset + maxDuration
  )
```

## 特徴抽出

軽量版の特徴量。

```ts
type AudioFeatures = {
  durationSec: number;
  rmsDb: number;
  peakDb: number;
  attackMs: number;
  decayMs: number;

  zeroCrossingRate: number;
  spectralCentroid: number;
  spectralFlatness: number;
  transientDensity: number;

  pitchHz?: number;
  pitchConfidence?: number;
  pitchStabilityCents?: number;
};
```

## pitch推定

軽量版はYINまたはautocorrelationで十分。

### 用途

- root note推定
- melodic one-shot判定
- wavetable候補判定
- drone候補判定

### 判定

```text
pitchConfidence > 0.7
pitchStabilityCents < 20
duration > 300ms
  → wavetable candidate
```

## wavetable抽出

既存WebCLAP synthに合わせる。

```ts
const FRAME_LEN = 2048;
const FRAMES = 8;
```

### 処理

```text
selected segment
  ↓
f0 track
  ↓
stable range
  ↓
8 frame positions
  ↓
extract cycles
  ↓
phase align
  ↓
resample to 2048
  ↓
normalize
  ↓
send to synth
```

### 抽出結果

```ts
type ExtractedWavetable = {
  name: string;
  frameLen: 2048;
  frames: 8;
  rootNote: number;
  samples: Float32Array; // frames * frameLen
};
```

## drone loop

軽量版では簡易loop point searchを使う。

```text
long segment
  ↓
candidate start/end
  ↓
RMS差
  ↓
波形端点差
  ↓
spectral centroid差
  ↓
score最小を選択
  ↓
crossfade
```

## UI設計

```text
┌──────────────────────────────────────────────┐
│ Drop Audio / Record                           │
├──────────────────────────────────────────────┤
│ Waveform + onset markers + selected region    │
├──────────────────┬───────────────────────────┤
│ Asset Grid        │ Inspector                 │
│ - Percussive      │ - waveform detail          │
│ - Melodic         │ - features                 │
│ - Wavetable       │ - type / tags              │
│ - Drone           │ - root note / loop points  │
│ - Phrase          │ - send to synth / export   │
├──────────────────┴───────────────────────────┤
│ WebCLAP Wavetable Synth Preview               │
└──────────────────────────────────────────────┘
```

## 必須操作

- D&Dで音声読み込み
- 波形上でregion選択
- onset marker編集
- slice再生
- asset type変更
- root note修正
- wavetable抽出
- Send to Synth
- export selected
- export all zip

## 軽量版MVP

### Lite-1: Chop Browser

- file load
- waveform
- onset detection
- slice grid
- slice preview
- wav export

### Lite-2: Auto Classify

- RMS
- ZCR
- spectral centroid
- spectral flatness
- attack/decay
- YIN pitch
- rule-based分類

### Lite-3: Wavetable

- manual regionからwavetable抽出
- root note推定
- WebCLAP synthへ送信
- 試奏

### Lite-4: Drone

- long segment detection
- loop point search
- crossfade loop
- export

### Lite-5: Mini Loop Builder

- percussion配置
- drone bed配置
- melodic one-shot配置
- 4〜8小節プレビュー
