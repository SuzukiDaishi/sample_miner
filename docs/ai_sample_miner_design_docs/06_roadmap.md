# 06. 開発ロードマップ

## 基本方針

いきなりフルAI実装を作らない。

まずは、既存の `z-audio-webclap-wavetable` と接続できる **Web Lite版** から作る。

理由:

- UI/UX検証が速い
- ブラウザだけでデモできる
- 重いAIのセットアップが不要
- 「録音からwavetable化して即鳴らす」体験を先に作れる
- 後からFull版の解析結果を同じmanifestで読める

## Phase 0: 共通schema

### 目的

Lite版とFull版で共通のmanifestを定義する。

### 作るもの

- `ProjectManifest`
- `AudioSource`
- `DerivedTrack`
- `Segment`
- `AudioAsset`
- `AudioFeatures`
- `WavetableInfo`
- `LoopPoints`

### ゴール

```text
どの処理エンジンからでも同じUIでassetを扱える
```

## Phase 1: Web Lite Chop Browser

### 作るもの

- 音声ファイルD&D
- Web Audio API decode
- waveform表示
- manual region selection
- onset detection
- slice grid
- slice preview
- wav export
- manifest export

### ゴール

```text
ブラウザだけで録音をチョップして素材化できる
```

### この時点でやらない

- AI分離
- CLAP分類
- MIDI化
- 高度wavetable

## Phase 2: 軽量特徴抽出・分類

### 作るもの

- RMS / peak
- attack / decay
- zero crossing rate
- spectral centroid
- spectral flatness
- transient density
- YIN / autocorrelation pitch
- rule-based classification

### 分類

- PercussiveOneShot
- MelodicOneShot
- WavetableCandidate
- DroneLoop
- NoiseTexture
- Phrase
- Reject

### ゴール

```text
自動で素材タイプごとに並ぶ
```

## Phase 3: WebCLAP Wavetable連携

### 作るもの

Sample Miner側:

- selected regionからwavetable抽出
- f0推定
- root note推定
- 8 frames × 2048 samples生成
- `ZWTL` packet encode

WebCLAP synth側:

- imported table slot
- `ZWTL` protocol parse
- `Wavetable::from_audio_frames`
- imported mip generation
- preview更新

### ゴール

```text
録音から作ったwavetableをWebCLAP synthで即弾ける
```

これが最初の大きなデモポイント。

## Phase 4: Drone Loop Maker

### 作るもの

- long segment detection
- loop point search
- RMS/spectral/waveform score
- crossfade loop
- loop preview
- export

### ゴール

```text
水音・風・環境音を自然なドローンループにできる
```

## Phase 5: Mini Loop Builder

### 作るもの

- 16step drum sequencer
- drone background layer
- melodic one-shot sampler
- phrase slice player
- 4〜8小節preview render
- stems export

### ゴール

```text
採掘した素材だけで簡単なループを生成できる
```

## Phase 6: Full Backend MVP

### 作るもの

- FastAPI backend
- job queue
- ffmpeg decode
- Demucs worker
- feature extraction worker
- CLAP worker
- Basic Pitch worker
- manifest writer

### ゴール

```text
音楽ファイルからdrums/bass/vocals/otherを分離し、素材化する
```

## Phase 7: AudioSep / Field Recording対応

### 作るもの

- AudioSep worker
- query preset
- Nature preset
- Foley preset
- Music Sampling preset
- separated track browser

### ゴール

```text
環境音や雑多な録音からも素材を掘れる
```

## Phase 8: 高品質wavetable

### 作るもの

- pitch stable region detector
- multi-frame wavetable
- phase alignment改善
- FFT mip generation
- `.zwt` export
- wavetable quality score

### ゴール

```text
録音由来wavetableをシンセ素材として実用化する
```

## Phase 9: Tauri / クライアントPC版

### 作るもの

- ローカルproject管理
- モデル管理
- local Python backend起動
- local Rust DSP
- DAWへのドラッグ&ドロップ
- batch process
- folder watch

### ゴール

```text
制作用の本格ローカルアプリにする
```

## Phase 10: DAW / Plugin連携

### 作るもの

- VST3/CLAP版
- WebCLAP版拡張
- sample browser plugin
- wavetable synth plugin
- drag to DAW
- MIDI/stem export
- SFZ / DecentSampler export

### ゴール

```text
AI Sample Minerで作った素材をDAWの中で直接使える
```

## 最短MVPまとめ

最短で強いデモはこれ。

```text
1. ブラウザに音声をD&D
2. 波形表示
3. 手動でメロディック区間を選択
4. f0推定
5. 8 frame wavetable抽出
6. WebCLAP wavetable synthに送信
7. キーボードで鳴らす
8. wavetable / manifest export
```

このMVPなら、音源分離AIなしでもプロジェクトの核が伝わる。
