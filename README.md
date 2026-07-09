# AI Sample Miner

任意の音声・音楽・録音から音楽素材(one-shot / wavetable / drone loop / phrase / MIDI)を
自動採掘するツール。設計は [docs/ai_sample_miner_design_docs/](docs/ai_sample_miner_design_docs/) 参照。

## 構成

| ディレクトリ | 内容 |
|---|---|
| [apps/web-lite/](apps/web-lite/) | ブラウザ完結の軽量版 (Phase 0〜5)。Vite + React + TS。DSP + ルールベース分類、wavetable 抽出 + 内蔵シンセ試奏、drone loop、Mini Loop Builder |
| [apps/backend/](apps/backend/) | フル版バックエンド (Phase 6〜8)。FastAPI + Demucs / CLAP / Basic Pitch (GPU)。stem 分離 → 素材化 → 共通 manifest 書き出し |
| datasets/ | テスト用音源 |

両者は **共通の manifest schema (v0.1)** を使う。Web Lite の「Full Backend」タブから
バックエンドの解析結果を同じ UI で閲覧・試聴できる。

## クイックスタート

```powershell
# Web Lite
cd apps/web-lite
npm install
npm run dev            # http://localhost:5173

# Full Backend (別ターミナル)
cd apps/backend
.\.venv\Scripts\python -m uvicorn app.main:app --port 8000
```

## 注意

自分の録音または使用権のある素材に対して使用してください。
既存楽曲の分離・素材化・再利用には権利上の注意が必要です。
