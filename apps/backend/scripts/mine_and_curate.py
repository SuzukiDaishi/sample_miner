"""楽曲から素材を採掘し、品質検証済みのおすすめ素材ライブラリを作る。

usage:
  python scripts/mine_and_curate.py <input.wav> [...] --out <dir>

各曲: run_pipeline (Demucs) → app.pipeline.curate で選定 →
curated/<song>/ へ書き出し + RECOMMENDED.md にカタログ生成。
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.pipeline.curate import Curated, curate_project  # noqa: E402
from app.pipeline.runner import run_pipeline  # noqa: E402


def sanitize(name: str) -> str:
    return re.sub(r"[^\w\-]+", "_", name).strip("_")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("inputs", nargs="+")
    ap.add_argument("--out", required=True)
    ap.add_argument("--mode", default="music")
    args = ap.parse_args()

    out = Path(args.out)
    report: list[str] = [
        "# 採掘済みおすすめ素材カタログ",
        "",
        "one-shot は「減衰が最後まで入っている・単発・attack が速い」ものを、",
        "声・フレーズ素材は「頭とお尻が無音に着地して途中で切れていない」ものを選定。",
        "全素材にマイクロフェードと -1dBFS normalize 適用済み。",
        "",
    ]

    for input_path in args.inputs:
        src = Path(input_path)
        song = sanitize(src.stem)[:60]
        print(f"\n=== {song} ===", flush=True)
        project_dir = out / "projects" / song

        if not (project_dir / "manifest.json").exists():
            (project_dir / "source").mkdir(parents=True, exist_ok=True)
            dest = project_dir / "source" / f"{song}.wav"
            if not dest.exists():
                shutil.copy2(src, dest)
            run_pipeline(
                project_dir,
                f"{song}.wav",
                args.mode,
                lambda st, f, m: print(f"  [{f * 100:5.1f}%] {st}: {m}", flush=True),
            )
        else:
            print("  (解析済み manifest を再利用)")

        manifest = json.loads(
            (project_dir / "manifest.json").read_text(encoding="utf-8")
        )
        bpm = manifest["assets"][0].get("bpm") if manifest["assets"] else None
        key = manifest["assets"][0].get("key") if manifest["assets"] else None

        kept: list[Curated] = curate_project(project_dir, out / "curated" / song)
        by_cat: dict[str, list[Curated]] = {}
        for r in kept:
            by_cat.setdefault(r.category, []).append(r)

        report.append(f"## {song}")
        report.append("")
        report.append(f"- BPM: {bpm:.0f} / Key: {key}" if bpm else f"- Key: {key}")
        report.append(f"- 採用素材: {len(kept)} 件")
        report.append("")
        report.append("| ファイル | 種別 | 長さ | note | 選定理由 |")
        report.append("|---|---|---|---|---|")
        for cat in sorted(by_cat):
            for r in by_cat[cat]:
                note = r.note or "—"
                report.append(
                    f"| `{song}/{r.out_rel}` | {cat} | {r.duration:.2f}s | {note} | {'、'.join(r.reasons[:3])} |"
                )
        report.append("")
        print(f"  curated: {len(kept)} 件 (bpm={bpm and round(bpm)}, key={key})")

    (out / "RECOMMENDED.md").write_text("\n".join(report), encoding="utf-8")
    print(f"\nwrote {out / 'RECOMMENDED.md'}")


if __name__ == "__main__":
    main()
