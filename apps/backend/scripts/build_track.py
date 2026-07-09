"""採掘済み素材から曲(16 小節ループ)を自動組み立てする CLI。

usage:
  python scripts/build_track.py <mined_dir> <song_name> [--bars 16] [--seed 0]

本体は app.pipeline.trackbuild (Full Backend の /api/projects/{id}/track と共通)。
出力: <mined_dir>/tracks/<song>/mix.wav + stems/ + track_info.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.pipeline.trackbuild import build_track  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("mined")
    ap.add_argument("song")
    ap.add_argument("--bars", type=int, default=16)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    mined = Path(args.mined)
    out_dir = mined / "tracks" / args.song
    qc = build_track(
        mined / "projects" / args.song,
        mined / "curated" / args.song,
        out_dir,
        bars=args.bars,
        seed=args.seed,
    )
    print(json.dumps(qc, indent=2, ensure_ascii=False))
    print(f"wrote {out_dir / 'mix.wav'}")


if __name__ == "__main__":
    main()
