# AI Sample Miner — Web Lite

`docs/ai_sample_miner_design_docs/` の Phase 0〜5(Web Lite 版)実装。
ブラウザだけで動く、録音・楽曲からの音楽素材採掘ツール。

## 起動

```bash
cd apps/web-lite
npm install
npm run dev      # http://localhost:5173
npm test         # vitest (DSP ユニットテスト + datasets 実音源スモーク)
npm run build    # tsc + vite build
```

## 使い方

1. 音声ファイル(wav/mp3/flac/m4a/ogg)を D&D → 自動で onset 検出 → チョップ → ルールベース分類
2. 波形: ドラッグで region 選択 / Shift+クリックでマーカー追加 / ダブルクリックでマーカー削除
3. Asset Grid: タイプ別(Percussive / Melodic / Wavetable Candidate / Drone / Noise / Phrase)に並ぶ。クリックで試聴
4. Inspector: 特徴量表示・タイプ手動修正・root note 修正・wav export
5. **Wavetable Synth タブ**: pitch の安定した region から 8 frame × 2048 の wavetable を抽出し、内蔵 AudioWorklet シンセ(ZWTL packet 経由)で即試奏。PC キーボード A〜; で演奏。`.zwt`(json + f32)export 対応
6. **Drone Loop タブ**: loop point 自動探索(waveform/RMS/spectral スコア)+ crossfade でシームレスループ生成
7. **Loop Builder タブ**: 16step ドラムシーケンサ + drone bed + melody / phrase レーンで 4〜8 小節ループを再生、OfflineAudioContext で mix + stems を zip export
8. **Export All (zip)**: manifest.json(docs 05 の共通 schema)+ 種別フォルダの wav + .zwt 一式

## 構成

- `src/manifest/schema.ts` — Lite/Full 共通 manifest 型 (Phase 0)
- `src/analysis/` — FFT / STFT / onset / slice / YIN / features / classify / wavetable-extract / loop-search
- `src/worker/analysis.worker.ts` — 解析は Web Worker で実行
- `src/synth/` — ZWTL protocol・AudioWorklet プレビューシンセ・.zwt export
  (将来 `z-audio-webclap-wavetable` へ ZWTL packet ごと差し替え可能)
- `src/sequencer/` — loop 再生スケジューラ + offline render

## 注意

自分の録音または使用権のある素材に対して使用してください。
