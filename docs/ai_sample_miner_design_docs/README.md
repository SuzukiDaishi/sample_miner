# AI Sample Miner / Resampling Tool 設計まとめ

この ZIP は、ここまでのやり取りをもとにした設計メモ集です。

目的は、任意の音声・音楽・録音から以下のような音楽素材を自動生成するツールの方針を固めることです。

- パーカッシブな短音 → one-shot / drum rack 素材
- メロディックな短音 → sampler / root note 付き素材
- ピッチが安定した音 → wavetable 素材
- 長尺ノイズ・環境音 → drone / ambience loop
- メロディックなフレーズ → chop / phrase loop / MIDI
- 録音由来 wavetable → WebCLAP wavetable synth で即試奏

## ファイル構成

| ファイル | 内容 |
|---|---|
| `00_project_overview.md` | プロジェクト全体像、思想、狙い |
| `01_core_pipeline.md` | 入力から素材化までの処理パイプライン |
| `02_web_lite_implementation.md` | ブラウザだけで動く軽量版の設計 |
| `03_full_implementation.md` | Webバックエンド/クライアントPC想定のフル実装 |
| `04_webclap_wavetable_integration.md` | 既存 `z-audio-webclap-wavetable` との統合方針 |
| `05_data_model_and_manifest.md` | 共通データモデル、manifest、asset schema |
| `06_roadmap.md` | MVPから本格版までの開発ロードマップ |
| `07_research_topics_and_risks.md` | 技術課題、研究テーマ、ライセンス/権利リスク |

## 推奨する進め方

最初に作るべきものは、重いAIを積んだ完成版ではなく、ブラウザ上で動く **軽量 Sample Miner** です。

```text
音声ファイルをD&D
  ↓
波形表示
  ↓
onset検出
  ↓
チョップ
  ↓
簡易分類
  ↓
wavetable候補生成
  ↓
既存WebCLAP wavetable synthへ送って試奏
```

この体験が固まってから、Demucs / AudioSep / CLAP / Basic Pitch などを使ったフル版へ進むのが堅い方針です。
