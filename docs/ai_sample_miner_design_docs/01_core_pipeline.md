# 01. コア処理パイプライン

## 1. 入力・前処理

### 入力形式

対応したい形式:

- wav
- mp3
- flac
- m4a
- ogg
- webm audio
- browser recording

### 前処理

```text
input file
  ↓
decode
  ↓
mono analysis buffer作成
  ↓
sample rate変換
  ↓
peak / RMS測定
  ↓
無音検出
  ↓
解析用チャンク分割
```

解析用と再生/書き出し用は分ける。

```text
再生/書き出し:
  original sample rate or 48kHz

解析:
  16kHz / 22.05kHz / 44.1kHz
```

## 2. 音源分離

軽量Web版では基本的に行わない。  
フル版では以下を使う。

| 用途 | 候補 |
|---|---|
| 音楽stem分離 | Demucs / HTDemucs |
| 4stem基準比較 | Open-Unmix |
| ボーカル除去系 | UVR系モデル |
| 環境音・任意音分離 | AudioSep / LASS系 |
| text query分離 | AudioSep |

### 音楽入力の分岐

```text
input music
  ↓
Demucs
  ↓
drums / bass / vocals / other
```

その後:

```text
drums
  → percussive one-shot extraction

bass
  → bass one-shot / phrase / root note

vocals
  → vocal chop / texture

other
  → melodic / harmonic / drone / wavetable candidate
```

### 環境音・録音入力の分岐

```text
field recording
  ↓
AudioSep query separation or direct analysis
```

query例:

```text
water sound
wind noise
rain
human voice
metal impact
footsteps
percussive sound
tonal drone
ambient noise
```

## 3. イベント検出・チョップ

### 基本

チョップはこのツールの体験を左右する重要部分。

```text
STFT
  ↓
spectral flux
  ↓
onset strength
  ↓
peak picking
  ↓
onset backtracking
  ↓
tail推定
  ↓
slice生成
```

### spectral flux

```text
flux[t] = sum(max(0, mag[t][bin] - mag[t-1][bin]))
```

### onset backtracking

onset検出点は実際のattackより少し後ろになりがち。  
そのため、直前のenergy minimumまで戻す。

```text
detected onset
  ↓
search previous local RMS minimum
  ↓
slice start
```

### tail推定

次のonsetまで切るだけではなく、エネルギー減衰を見る。

```text
end candidate:
  - next onset - margin
  - RMSがpeakから-40dB以下
  - 最大長制限
```

## 4. 特徴抽出

### 最低限必要な特徴

```rust
struct AudioFeatures {
    duration_sec: f32,
    rms_db: f32,
    peak_db: f32,

    attack_ms: f32,
    decay_ms: f32,
    transient_density: f32,

    spectral_centroid_mean: f32,
    spectral_flatness_mean: f32,
    zero_crossing_rate_mean: f32,

    f0_median_hz: Option<f32>,
    f0_confidence: f32,
    f0_stability_cents: Option<f32>,
    voiced_ratio: f32,

    harmonic_ratio: f32,
    percussive_ratio: f32,
}
```

### 分類に使う特徴

| 特徴 | 用途 |
|---|---|
| duration | one-shot / phrase / drone判定 |
| attack_ms | percussion判定 |
| decay_ms | one-shot tail推定 |
| spectral_centroid | 明るさ |
| spectral_flatness | noiseらしさ |
| zero crossing rate | noise / transient判定 |
| f0 confidence | melodic判定 |
| f0 stability | wavetable / drone判定 |
| transient density | drone / phrase判定 |
| harmonic/percussive ratio | melodic/percussive判定 |

## 5. ルールベース分類

AIなしでも、初期分類は十分できる。

```text
短い + attack速い + pitch不安定
  → PercussiveOneShot

短い + pitch安定
  → MelodicOneShot

長い + transient少ない + pitch安定
  → DroneLoop / WavetableCandidate

長い + flatness高い + transient少ない
  → NoiseTexture / AmbienceLoop

複数onset + pitch/chroma変化あり
  → MelodicPhrase / SliceLoop
```

### TypeScript例

```ts
function classify(features: AudioFeatures): AssetType {
  if (
    features.durationSec < 1.2 &&
    features.attackMs < 35 &&
    (features.pitchConfidence ?? 0) < 0.45
  ) {
    return "PercussiveOneShot";
  }

  if (
    features.durationSec < 2.5 &&
    (features.pitchConfidence ?? 0) > 0.65 &&
    (features.pitchStabilityCents ?? 999) < 25
  ) {
    return "MelodicOneShot";
  }

  if (
    features.durationSec > 3.0 &&
    features.transientDensity < 1.0 &&
    (features.pitchConfidence ?? 0) > 0.6
  ) {
    return "DroneLoop";
  }

  if (
    features.durationSec > 3.0 &&
    features.spectralFlatness > 0.45 &&
    features.transientDensity < 1.0
  ) {
    return "NoiseTexture";
  }

  return "Phrase";
}
```

## 6. wavetable化

### 基本方針

メロディック素材から安定した周期波形を取り出す。

```text
melodic segment
  ↓
f0推定
  ↓
pitch stable region検出
  ↓
周期長 = sample_rate / f0
  ↓
複数周期を切り出し
  ↓
phase align
  ↓
cycle averaging
  ↓
2048 samplesへresample
  ↓
single-cycle wavetable
```

### multi-frame wavetable

```text
安定区間を時間方向に8〜64地点でサンプリング
  ↓
各地点でsingle-cycle抽出
  ↓
frame列として保存
```

既存 `z-audio-webclap-wavetable` に合わせるなら、

```text
frame_len = 2048
frames = 8
sample_format = f32
range = [-1.0, 1.0]
```

を標準にする。

## 7. drone / ambience loop化

長尺素材はループ化する。

```text
long segment
  ↓
transient densityが低い範囲を選ぶ
  ↓
start/end候補を多数探索
  ↓
RMS差
  ↓
spectral差
  ↓
MFCC差
  ↓
waveform endpoint差
  ↓
crossfade後のclick量
  ↓
best loop point選択
```

### loop score

```text
score =
  waveform_endpoint_distance * 0.4
+ rms_difference * 0.2
+ spectral_distance * 0.3
+ transient_penalty * 0.1
```

### crossfade

素材ごとに変える。

| 素材 | crossfade |
|---|---|
| one-shot | 2〜10ms |
| tonal drone | 20〜100ms |
| water/wind/noise | 100〜500ms |
| rhythmic phrase | beatに合わせる |

## 8. 自動構成

最初は完全自動作曲ではなく、簡易loop builderで十分。

```text
percussion one-shot
  → 16step drum pattern

drone loop
  → background bed

melodic one-shot
  → sampler phrase

phrase chop
  → slice sequencer
```

8小節程度のループ生成を目標にする。
