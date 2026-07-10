"""keep/discard 判定から個人 ranker を学習する (docs 08 §3.4 D-2)。

usage:
  python scripts/train_ranker.py [--projects-dir <dir>] [--out <weights.json>] [--l2 1.0]

<projects-dir>/*/manifest.json の assets から userRating 付きのものを集め、
rendered wav の CLAP audio embedding を特徴量にロジスティック回帰
(keep=1 / discard=0) を学習して weights JSON を書き出す。
Web Lite の export zip を展開したフォルダ群も同じ形式なので指定できる。
学習には torch + transformers が必要 (推論側は numpy のみ)。
"""
from __future__ import annotations

import argparse
import datetime
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import PROJECTS_DIR, RANKER_PATH  # noqa: E402
from app.models.availability import model_availability  # noqa: E402
from app.pipeline import ranker  # noqa: E402

MIN_SAMPLES = 20
RECOMMENDED_SAMPLES = 200  # docs 08 D-2「数百件貯まってから」


def collect_rated(projects_dir: Path) -> tuple[list[np.ndarray], list[int]]:
    from app.models import clap_worker

    X: list[np.ndarray] = []
    y: list[int] = []
    for manifest_path in sorted(projects_dir.glob("*/manifest.json")):
        project_dir = manifest_path.parent
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for a in manifest.get("assets", []):
            rating = a.get("userRating")
            if rating not in ("keep", "discard") or not a.get("renderedPath"):
                continue
            wav = project_dir / a["renderedPath"]
            if not wav.exists():
                continue
            data, sr = sf.read(wav, always_2d=True, dtype="float32")
            emb = clap_worker.embed_audio(data.mean(axis=1), sr)
            if emb is None:
                continue
            X.append(emb)
            y.append(1 if rating == "keep" else 0)
        print(f"  {project_dir.name}: 累計 {len(y)} 件", flush=True)
    return X, y


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--projects-dir", default=str(PROJECTS_DIR))
    ap.add_argument("--out", default=str(RANKER_PATH))
    ap.add_argument("--l2", type=float, default=1.0)
    args = ap.parse_args()

    if not model_availability()["clap"]:
        sys.exit("CLAP (torch + transformers) が必要です。推論側は numpy のみで動きます。")

    print(f"収集: {args.projects_dir}")
    X_list, y_list = collect_rated(Path(args.projects_dir))
    n = len(y_list)
    n_keep = sum(y_list)
    if n < MIN_SAMPLES or n_keep == 0 or n_keep == n:
        sys.exit(
            f"データ不足: {n} 件 (keep {n_keep} / discard {n - n_keep})。"
            f" 最低 {MIN_SAMPLES} 件かつ両クラス必要です。"
        )
    if n < RECOMMENDED_SAMPLES:
        print(
            f"警告: {n} 件は過学習しやすい水準です (推奨 {RECOMMENDED_SAMPLES} 件以上)。"
            " L2 正則化と blend 重み 0.2 である程度抑えますが、判定を増やして再学習してください。"
        )

    X = np.stack(X_list)
    y = np.asarray(y_list, dtype=np.float64)
    w, b = ranker.train_logreg(X, y, l2=args.l2)
    acc = float(((np.asarray(ranker.predict_proba(X, w, b)) >= 0.5) == (y == 1)).mean())
    print(f"学習完了: {n} 件 (keep {n_keep} / discard {n - n_keep}) train accuracy {acc:.2f}")

    from app.models.clap_worker import MODEL_ID

    ranker.save_weights(
        Path(args.out),
        w,
        b,
        {
            "model": MODEL_ID,
            "trainedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "nSamples": n,
            "nKeep": n_keep,
            "l2": args.l2,
            "trainAccuracy": acc,
        },
    )
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
