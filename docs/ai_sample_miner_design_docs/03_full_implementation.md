# 03. Webバックエンド / クライアントPC想定のフル実装

## 目的

重いAIモデルと高品質DSPを使う本命実装。

```text
音声/音楽/録音
  ↓
音源分離AI
  ↓
チョップ
  ↓
特徴抽出
  ↓
AI分類
  ↓
wavetable生成
  ↓
drone loop生成
  ↓
phrase/MIDI化
  ↓
8小節loop生成
  ↓
DAW向け書き出し
```

## 実行形態

### A. Webバックエンド型

```text
Browser UI
  ↓
FastAPI backend
  ↓
GPU worker
  ↓
analysis results
  ↓
Browser UIで編集
```

メリット:

- GPUサーバーを使える
- UI開発が楽
- Python AIスタックをそのまま使える
- モデル管理が一箇所で済む

デメリット:

- 音声アップロードが必要
- プライバシー/権利面に注意
- サーバー費用
- 長尺ファイル転送が重い

### B. クライアントPC型

```text
Tauri / Electron / Native UI
  ↓
local backend
  ↓
local GPU/CPU inference
  ↓
local project folder
```

メリット:

- ローカル完結
- DAW連携しやすい
- ファイルD&D/書き出しが自然
- 素材の権利/プライバシーに強い

デメリット:

- インストールが重い
- モデル配布が重い
- GPU/OS差分対応が必要
- Python同梱やONNX化が課題

## 推奨アーキテクチャ

```text
Frontend
  React / Tauri / Web UI
    ↓
Backend API
  FastAPI / Python
    ↓
Job Queue
  asyncio / Celery / RQ
    ↓
AI Workers
  Demucs
  AudioSep
  CLAP
  Basic Pitch
  CREPE
  PANNs / YAMNet / BEATs
    ↓
DSP Core
  Python librosa/Essentia initially
  Rust audio-core later
    ↓
Storage
  project folder
  sqlite
  wav assets
  manifest.json
```

## PythonとRustの役割分担

### Python

AI・研究系を担当。

- Demucs
- AudioSep
- CLAP
- PANNs / YAMNet / BEATs
- Basic Pitch
- CREPE
- librosa
- Essentia Python
- prototyping

### Rust

プロダクトのDSP・音声エンジンを担当。

- 高速wav decode/encode
- feature extraction
- onset
- wavetable extraction
- loop search
- audio rendering
- export
- WebAssembly
- VST3/CLAP/WebCLAPとの共有

## AIモデル候補

| 領域 | 候補 | 用途 |
|---|---|---|
| 音楽stem分離 | Demucs / HTDemucs | drums/bass/vocals/other |
| 参照実装 | Open-Unmix | 4stem比較 |
| text-query分離 | AudioSep | water/wind/voice等 |
| audio-text分類 | CLAP | 任意タグ分類 |
| audio event分類 | YAMNet | AudioSet 521 class |
| 汎用音分類 | PANNs | AudioSet tagging / embedding |
| 表現学習 | BEATs | embedding / fine-tuning |
| MIDI化 | Basic Pitch | phrase to MIDI |
| f0推定 | CREPE / pYIN / YIN | root note / pitch stability |

## フル版処理パイプライン

### 1. 前処理

```text
input
  ↓
ffmpeg decode
  ↓
master.wav 48kHz
  ↓
analysis copies
    - 44.1kHz
    - 32kHz
    - 22.05kHz
    - 16kHz
```

モデルによって要求sample rateが違うため、解析用コピーを分ける。

### 2. 入力ルーティング

```text
Auto mode:
  - 音楽っぽい → Demucs
  - 環境音っぽい → AudioSep候補 or direct analysis
  - 声が多い → vocal/speech query
  - 不明 → original + Demucs + selected queries
```

UI上では手動モードも用意する。

```text
Mode:
  - Auto
  - Music
  - Field Recording
  - Voice
  - No Separation
```

### 3. 分離

#### Music mode

```text
Demucs
  ↓
drums
bass
vocals
other
```

#### Field Recording mode

```text
AudioSep queries:
  water sound
  wind noise
  rain
  metal impact
  footsteps
  human voice
  percussive sound
  tonal drone
```

### 4. stem別チョップ

```text
drums:
  onset強め
  short one-shot重視

vocals:
  無音区間
  syllable/chop重視

bass/melodic:
  onset + pitch変化
  note/phrase重視

ambient:
  long stable segment
  transient低密度
```

### 5. 特徴抽出

フル版ではMFCCやchromaも保存。

```rust
struct AudioFeatures {
    duration_sec: f32,
    rms_db: f32,
    peak_db: f32,

    attack_ms: f32,
    decay_ms: f32,
    transient_density: f32,

    spectral_centroid_mean: f32,
    spectral_centroid_std: f32,
    spectral_flatness_mean: f32,
    zero_crossing_rate_mean: f32,

    mfcc_mean: Vec<f32>,
    mfcc_std: Vec<f32>,

    f0_median_hz: Option<f32>,
    f0_confidence: f32,
    f0_stability_cents: Option<f32>,
    voiced_ratio: f32,

    harmonic_ratio: f32,
    percussive_ratio: f32,

    bpm: Option<f32>,
    key: Option<String>,
}
```

### 6. AI分類

```text
1. ルールベース大分類
2. CLAPでタグ候補
3. PANNs/YAMNetでイベント補助
4. ユーザー修正
5. 修正ログを保存
```

CLAP prompt例:

```text
kick drum
snare drum
hi-hat
percussion hit
metal impact
wood hit
water sound
wind noise
ambient drone
tonal drone
sustained musical note
vocal chop
bass note
melodic phrase
noise texture
```

### 7. wavetable生成

#### single-cycle

```text
F0安定区間検出
  ↓
周期抽出
  ↓
phase align
  ↓
cycle average
  ↓
DC除去
  ↓
2048 samples化
```

#### multi-frame

```text
安定した長めの音
  ↓
時間方向に8〜64地点
  ↓
各地点でsingle-cycle抽出
  ↓
phase alignment
  ↓
frame間normalize
  ↓
wavetable保存
```

### 8. drone loop生成

```text
long segment
  ↓
transient densityが低い範囲
  ↓
start/end候補探索
  ↓
MFCC距離
  ↓
spectral距離
  ↓
RMS差
  ↓
pitch/chroma差
  ↓
crossfade後クリック量
  ↓
best loop
```

### 9. MIDI化

```text
melodic phrase
  ↓
Basic Pitch
  ↓
note events
  ↓
quantize optional
  ↓
MIDI export
```

必ずconfidenceを持つ。

```json
{
  "asset_id": "phrase_001",
  "midi_path": "midi/phrase_001.mid",
  "confidence": 0.62,
  "note_count": 14
}
```

## フル版出力

```text
project_001/
  source/
    original.wav

  stems/
    drums.wav
    bass.wav
    vocals.wav
    other.wav

  one_shots/
    kick_001.wav
    snare_002.wav
    metal_hit_003.wav

  melodic/
    tone_C3_001.wav

  wavetables/
    voice_a3.zwt
    metal_c4_8frames.zwt

  drones/
    water_loop_001.wav
    wind_loop_002.wav

  phrases/
    vocal_phrase_001.wav
    melody_phrase_002.wav

  midi/
    phrase_001.mid

  arrangements/
    loop_8bar.wav
    stems/

  manifest.json
```

## パフォーマンス方針

### キャッシュ

処理結果は必ずキャッシュする。

```text
content_hash + model_name + model_version + params
  ↓
cache key
```

### 非同期job

重い処理はjobにする。

```text
Upload/Select
  ↓
Create Project
  ↓
Job: decode
  ↓
Job: separation
  ↓
Job: segmentation
  ↓
Job: features
  ↓
Job: classification
  ↓
Job: render assets
```

### GPU/CPU

- GPUあり: Demucs / AudioSep / CLAP / Basic Pitch
- CPUのみ: 軽量モード、長時間待ち
- ONNX Runtime化: 配布しやすいモデルから検討
- Rust/Candle: 将来的な完全Rust化候補

## GUI

Web Liteと同じUIでFullの結果も読めるよう、manifestを共通化する。

追加UI:

- job progress
- model selection
- stem view
- confidence view
- re-run analysis
- batch export
- DAW folder export
- drag & drop to DAW
