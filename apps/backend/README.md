# AI Sample Miner — Full Backend

`docs/ai_sample_miner_design_docs/03_full_implementation.md`(Phase 6〜8)の実装。
FastAPI + job queue で、音楽ファイルを Demucs 分離 → stem 別チョップ →
特徴抽出 → 分類(+CLAP タグ)→ wavetable / drone loop / MIDI 化まで自動実行し、
Web Lite と**共通の manifest schema (v0.1)** で書き出す。

## セットアップ

```powershell
cd apps/backend
py -3.12 -m venv .venv
.\.venv\Scripts\python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121
.\.venv\Scripts\python -m pip install -r requirements.txt
```

ffmpeg が PATH にあること(mp3/flac/m4a 入力に必要。wav のみなら不要)。

## 起動

```powershell
.\.venv\Scripts\python -m uvicorn app.main:app --port 8000
```

Web Lite (http://localhost:5173) の「Full Backend」タブから接続するか、直接 API を叩く。

## API

| Method | Path | 内容 |
|---|---|---|
| GET | `/api/health` | モデル利用可否 (demucs / clap / basicPitch / aesthetics / device) |
| POST | `/api/projects` | multipart `file` + `mode` (auto/music/field/voice/none) → `{projectId, jobId}` |
| GET | `/api/jobs/{id}` | job 進捗 (stage / progress / status) |
| GET | `/api/projects` | プロジェクト一覧 |
| GET | `/api/projects/{id}/manifest` | manifest.json (schema v0.1) |
| POST | `/api/projects/{id}/assets/{assetId}/rating` | JSON `{"rating": "keep"\|"discard"\|null}` → manifest へ書き戻し (個人 ranker の教師データ。再解析すると消える) |
| POST | `/api/projects/{id}/track` | Form `bars` (4/8/16/32) + `seed` → 素材キュレーション + トラック自動組み立て job |
| GET | `/api/projects/{id}/files/{path}` | 生成された wav / .zwt / .mid / track/mix.wav の取得 |

## パイプライン (mode=auto/music, Demucs あり)

```
upload → ffmpeg decode (master.wav 48kHz)
  → Demucs htdemucs (drums/bass/vocals/other, GPU)
  → stem 別チョップ (drums=onset強め / vocals=無音区間 / other=onset+pitch)
  → librosa 特徴抽出 (MFCC/HPSS/pYIN/bpm/key)
  → ルールベース分類 + CLAP zero-shot タグ (候補提示のみ)
  → wavetable 生成 (pitch stable region → 8×2048 .zwt)
  → drone loop 探索 (MFCC 距離込みの loop score + crossfade)
  → Basic Pitch で phrase → MIDI (confidence 付き)
  → manifest.json + 素材フォルダ書き出し
```

AI モデルが未インストールでも起動でき、該当ステージは自動でスキップされる
(`/api/health` で確認可能)。mode=none で分離なし解析。

## トラック自動組み立て (`/track`)

解析済みプロジェクトの素材を品質選定(`app/pipeline/curate.py`: 減衰完結 one-shot /
無音着地フレーズ)し、曲の BPM/Key に合わせて 16 小節を組む
(`app/pipeline/trackbuild.py`: 4つ打ち + ベース進行 + wavetable パッド + ボーカル配置)。
出力は `projects/<id>/track/{mix.wav, stems/, track_info.json}`。
CLI 版: `scripts/mine_and_curate.py`(バッチ採掘 + RECOMMENDED.md)と
`scripts/build_track.py`(同ロジックの薄いラッパー)。

## 個人 ranker (docs 08 §3.4 D-2)

Web Lite / Full Backend で付けた keep/discard 判定を教師に、CLAP embedding 上の
ロジスティック回帰で「自分にとってのキャッチーさ」を学習できる:

```powershell
.\.venv\Scripts\python scripts\train_ranker.py    # projects/ の判定から学習
```

出力 `ranker_weights.json` (`SAMPLE_MINER_RANKER_PATH` で変更可) があると、
以降の解析で各 segment に `personalScore` が付き、curate の順位に blend される。
判定が数百件貯まってからの学習を推奨 (少ないと過学習警告が出る)。

## 出力 (projects/<id>/)

```
manifest.json
source/original.* , master.wav
tracks/original.wav , demucs_{drums,bass,vocals,other}.wav
one_shots/ melodic/ wavetables/(.zwt.json/.zwt.f32/.wav) drones/ phrases/ midi/
```

## テスト

```powershell
.\.venv\Scripts\python -m pytest
```

## 注意

既存楽曲の分離・素材化は権利的に注意。自分の録音または使用権のある素材向け。
