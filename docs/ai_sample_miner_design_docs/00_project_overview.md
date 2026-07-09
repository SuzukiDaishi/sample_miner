# 00. プロジェクト全体像

## 目的

任意の音声・音楽・録音を入力として、音楽制作に使える素材へ自動変換するツールを作る。

想定する入力はかなり広い。

- 楽曲
- フィールドレコーディング
- 水音、風、雨、街の音などの環境音
- 声、楽器、効果音
- 適当なスマホ録音
- ゲーム用の素材録音
- 既存の自作音源・ライブラリ

出力は、DAWやWeb上のシンセで即使える音楽素材。

| 入力内の音 | 変換後の素材 |
|---|---|
| アタックの強い短音 | percussion one-shot |
| ピッチのある短音 | melodic one-shot / sampler素材 |
| ピッチが安定した音 | single-cycle / multi-frame wavetable |
| 長いノイズ・環境音 | drone loop / ambience loop |
| メロディックなフレーズ | sliced phrase / MIDI |
| 声 | vocal chop / texture |

## コア思想

このプロジェクトは、最初から「AIが曲を全部作るツール」として設計しないほうがよい。

まずは、

> 現実の音・録音・音楽から、使える音楽素材を採掘するツール

として作る。

つまり名前を付けるなら、

- AI Sample Miner
- AI Resampling Tool
- Recording-to-Wavetable Tool
- Field Recording Sampler
- Audio Material Extractor

のような方向。

## 全体パイプライン

```text
任意の音声/音楽/録音
  ↓
前処理
  ↓
音源分離 or そのまま解析
  ↓
イベント検出 / チョップ
  ↓
音響特徴抽出
  ↓
分類 / タグ付け
  ↓
素材化
    - one-shot
    - melodic one-shot
    - wavetable
    - drone loop
    - phrase chop
    - MIDI
  ↓
プレビュー / 編集
  ↓
DAW向け書き出し
```

## 2パターンの実装

実装は大きく2系統に分ける。

| パターン | 役割 | 方針 |
|---|---|---|
| Webフロントエンド軽量版 | すぐ試せる / ブラウザ完結 / UI検証 | 分離AIなし、軽量DSP中心 |
| Webバックエンド / クライアントPC版 | 本命 / 高品質 / 重AIあり | Demucs, AudioSep, CLAP, Basic Pitch等を使用 |

### 1. Webフロントエンド軽量版

ブラウザだけで動作する。

やること:

- audio file decode
- waveform表示
- onset検出
- manual / auto chop
- 簡易分類
- pitch推定
- wavetable候補抽出
- drone loop候補抽出
- zip export
- 既存WebCLAP wavetable synthで試奏

やらないこと:

- 高品質な音源分離
- 大規模AI分類
- 高精度MIDI化
- 長尺音源の重解析

### 2. フル実装

ローカルPCまたはWebバックエンドで重いAIを使う。

やること:

- Demucsによる音楽stem分離
- AudioSepによるtext-query分離
- CLAPによる音声-テキスト分類
- PANNs / YAMNet / BEATsによる音イベント分類
- Basic Pitch / CREPEによる採譜・f0推定
- 高品質wavetable生成
- 高品質drone loop生成
- 8小節loop builder
- MIDI / stems / SFZ / wavetable export

## 最初の価値

最初のMVPで一番重要な体験はこれ。

```text
ブラウザに音を投げる
  ↓
いい感じにチョップされる
  ↓
素材タイプごとに並ぶ
  ↓
クリックで鳴らせる
  ↓
メロディック素材からwavetable化
  ↓
WebCLAPシンセで即試奏できる
```

この時点で、音源分離AIがなくてもかなり価値がある。
