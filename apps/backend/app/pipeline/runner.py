"""フル版パイプライン本体 (docs 03)。
decode → (Demucs) → stem 別チョップ → 特徴抽出 → 分類(+CLAP タグ)
→ wavetable → drone loop → MIDI 化 → asset render → manifest.json
manifest は Web Lite と共通の schema v0.1 (docs 05)。
"""
from __future__ import annotations

import datetime
import logging
import re
from pathlib import Path
from typing import Callable

import librosa
import numpy as np
import soundfile as sf

from ..config import (
    MAX_DRONES,
    MAX_MIDI,
    MAX_WAVETABLES,
    RANKER_PATH,
)
from ..models.availability import model_availability
from . import classify as clf
from .decode import decode_to_master, load_wav, to_mono
from .features import compute_features, estimate_bpm, estimate_key
from .hooks import compute_hook_map, segment_hook_score
from .loops import find_best_loop, render_loop
from .segment import segment_track
from .wavetable import FRAME_LEN, FRAMES, WavetableError, extract_wavetable, write_zwt

log = logging.getLogger("sample_miner")

ProgressCb = Callable[[str, float, str], None]

FOLDER_BY_TYPE = {
    "PercussiveOneShot": "one_shots",
    "Impact": "one_shots",
    "MelodicOneShot": "melodic",
    "BassOneShot": "melodic",
    "WavetableCandidate": "melodic",
    "Wavetable": "wavetables",
    "DroneLoop": "drones",
    "NoiseTexture": "drones",
    "AmbienceLoop": "drones",
    "MelodicPhrase": "phrases",
    "VocalChop": "phrases",
    "SliceLoop": "phrases",
}

TYPE_PREFIX = {
    "PercussiveOneShot": "perc",
    "MelodicOneShot": "tone",
    "BassOneShot": "bass",
    "Impact": "impact",
    "WavetableCandidate": "wtcand",
    "DroneLoop": "drone",
    "NoiseTexture": "noise",
    "AmbienceLoop": "amb",
    "MelodicPhrase": "phrase",
    "VocalChop": "vocal",
    "SliceLoop": "sliceloop",
    "Reject": "reject",
}

STEM_TO_KIND = {
    "drums": "DemucsDrums",
    "bass": "DemucsBass",
    "vocals": "DemucsVocals",
    "other": "DemucsOther",
}

# CLAP タグ付けの上限 (時間対策)
MAX_CLAP_SEGMENTS = 24


def sanitize(name: str) -> str:
    return re.sub(r"[^\w\-]+", "_", name).strip("_") or "asset"


def _json_safe(obj):
    """NaN/inf/numpy 型を JSON 化可能な値へ変換する。"""
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating, float)):
        f = float(obj)
        return f if np.isfinite(f) else None
    return obj


def midi_to_note_name(midi: int) -> str:
    names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    return f"{names[midi % 12]}{midi // 12 - 1}"


def run_pipeline(
    project_dir: Path,
    original_filename: str,
    mode: str,
    progress: ProgressCb,
) -> dict:
    """mode: auto | music | field | voice | none"""
    avail = model_availability()

    # ---- 1. decode ----
    progress("decode", 0.0, "decoding to 48kHz master")
    source_dir = project_dir / "source"
    original_path = source_dir / original_filename
    master_path = source_dir / "master.wav"
    decode_to_master(original_path, master_path)
    channels, sr = load_wav(master_path)
    mono = to_mono(channels)
    duration_sec = len(mono) / sr

    bpm = estimate_bpm(mono, sr)
    key = estimate_key(mono, sr)

    # hook 反復検出 (docs 08 §3.2): 原曲全体の反復領域マップを 1 回だけ計算し、
    # 各 segment の features へ hookScore として付与する (curate のランキング用)
    hook_map = None
    if mode != "field":
        progress("decode", 0.03, "analyzing hook repetition")
        try:
            hook_map = compute_hook_map(mono, sr)
        except Exception as e:  # 反復検出は補助シグナルなので失敗しても続行
            log.warning("hook map failed: %s", e)

    # ---- 2. ルーティング + 分離 ----
    use_demucs = mode in ("auto", "music") and avail["demucs"]
    tracks: list[dict] = []  # {id, kind, stemName|None, channels, mono, model...}
    tracks_dir = project_dir / "tracks"
    tracks_dir.mkdir(parents=True, exist_ok=True)

    sf.write(tracks_dir / "original.wav", channels.T, sr, subtype="PCM_16")
    tracks.append(
        {
            "id": "track_001",
            "kind": "Original",
            "stem": None,
            "wavPath": "tracks/original.wav",
            "channels": channels,
            "mono": mono,
        }
    )

    if use_demucs:
        progress("separation", 0.05, "running Demucs (htdemucs)")
        from ..models import demucs_worker

        stems = demucs_worker.separate(master_path)
        for i, (stem_name, (stem_ch, stem_sr)) in enumerate(stems.items()):
            if stem_sr != sr:
                stem_ch = librosa.resample(stem_ch, orig_sr=stem_sr, target_sr=sr)
            wav_rel = f"tracks/demucs_{stem_name}.wav"
            sf.write(project_dir / wav_rel, stem_ch.T, sr, subtype="PCM_16")
            tracks.append(
                {
                    "id": f"track_{i + 2:03d}",
                    "kind": STEM_TO_KIND.get(stem_name, "Manual"),
                    "stem": stem_name,
                    "wavPath": wav_rel,
                    "channels": stem_ch.astype(np.float32),
                    "mono": to_mono(stem_ch.astype(np.float32)),
                    "modelName": demucs_worker.MODEL_NAME,
                }
            )

    # ---- 3. stem 別チョップ + 特徴抽出 + 分類 ----
    segments_json: list[dict] = []
    assets_json: list[dict] = []
    seg_records: list[dict] = []  # 内部処理用

    # 分離した場合は original を重複チョップしない (stems から素材化)
    chop_tracks = tracks[1:] if use_demucs else tracks[:1]
    if mode == "voice" and not use_demucs:
        chop_tracks = [dict(tracks[0], stem="vocals")]

    total_segs = 0
    for track in chop_tracks:
        kind = track["stem"] or ("original" if mode != "field" else "ambient")
        raw = segment_track(track["mono"], sr, kind)
        total_segs += len(raw)
        track["raw_segments"] = raw

    done = 0
    for track in chop_tracks:
        for raw in track.get("raw_segments", []):
            seg_mono = track["mono"][raw.start : raw.end]
            feats = compute_features(seg_mono, sr)
            feats["bpm"] = bpm
            feats["key"] = key
            if hook_map is not None:
                # stem は原曲と同一タイムラインなので位置がそのまま使える
                feats["hookScore"] = segment_hook_score(
                    hook_map, raw.start / sr, raw.end / sr
                )
            asset_type = clf.classify(feats, stem=track["stem"])
            confidence = clf.classification_confidence(asset_type, feats)

            index = len(segments_json) + 1
            seg_id = f"seg_{index:03d}"
            asset_id = f"asset_{index:03d}"
            seg_records.append(
                {
                    "segId": seg_id,
                    "assetId": asset_id,
                    "track": track,
                    "start": raw.start,
                    "end": raw.end,
                    "features": feats,
                    "type": asset_type,
                    "confidence": confidence,
                }
            )
            segments_json.append(
                {
                    "id": seg_id,
                    "trackId": track["id"],
                    "startSec": raw.start / sr,
                    "endSec": raw.end / sr,
                    "startSample": int(raw.start),
                    "endSample": int(raw.end),
                    "detectionMethod": raw.method,
                    "confidence": confidence,
                    "features": feats,
                }
            )
            done += 1
            if done % 8 == 0:
                progress(
                    "features",
                    0.15 + 0.35 * done / max(1, total_segs),
                    f"features {done}/{total_segs}",
                )

    # ---- 4. モデルベース補助スコア (候補提示のみ) ----
    # 対象は「長い順」ではなく catchiness (Layer A/B) 上位順 (docs 08 §3.3)。
    # キャッチー候補にこそタグ・対照スコア・美的評価を付ける
    targets: list[dict] = []
    if avail["clap"] or avail["aesthetics"]:
        from .curate import catchiness_for_asset

        scored: list[tuple[float, dict]] = []
        for rec in seg_records:
            if rec["type"] == "Reject":
                continue
            seg_mono = rec["track"]["mono"][rec["start"] : rec["end"]]
            c, _ = catchiness_for_asset(seg_mono, sr, rec["features"], rec["type"])
            scored.append((c, rec))
        scored.sort(key=lambda t: -t[0])
        targets = [rec for _, rec in scored[:MAX_CLAP_SEGMENTS]]

    # ---- 4a. CLAP タグ + 対照ペアスコア + 個人 ranker ----
    if avail["clap"] and targets:
        progress("classification", 0.5, "CLAP tagging")
        from ..models import clap_worker
        from . import ranker

        # 個人 ranker (docs 08 §3.4 D-2): CLAP embedding を流用して推論 (numpy のみ)
        weights = ranker.load_weights(RANKER_PATH)
        for i, rec in enumerate(targets):
            seg_mono = rec["track"]["mono"][rec["start"] : rec["end"]]
            try:
                clap = clap_worker.analyze_audio(seg_mono, sr)
            except Exception as e:  # タグ付けは補助なので失敗しても続行
                log.warning("CLAP tagging failed: %s", e)
                break
            rec["features"]["clapTags"] = clap["tags"]
            if clap["catchy"] is not None:
                rec["features"]["clapCatchy"] = clap["catchy"]
            emb = clap.get("embedding")
            if weights is not None and emb is not None:
                if len(emb) == weights["dim"]:
                    rec["features"]["personalScore"] = float(
                        ranker.predict_proba(emb, weights["w"], weights["b"])
                    )
                else:
                    log.warning(
                        "ranker dim mismatch: %d != %d", len(emb), weights["dim"]
                    )
                    weights = None
            if i % 4 == 0:
                progress("classification", 0.5 + 0.07 * i / len(targets), f"CLAP {i}/{len(targets)}")

    # ---- 4b. Audiobox-Aesthetics (docs 08 §3.4 D-1) ----
    if avail["aesthetics"] and targets:
        progress("classification", 0.58, "aesthetics scoring")
        from ..models import aesthetics_worker

        for i, rec in enumerate(targets):
            seg_mono = rec["track"]["mono"][rec["start"] : rec["end"]]
            try:
                aes = aesthetics_worker.score_audio(seg_mono, sr)
            except Exception as e:  # 美的評価は補助なので失敗しても続行
                log.warning("aesthetics scoring failed: %s", e)
                break
            if aes and "CE" in aes and "PQ" in aes:
                rec["features"]["aesScore"] = aesthetics_worker.normalize_aesthetics(
                    aes["CE"], aes["PQ"]
                )
            if i % 4 == 0:
                progress(
                    "classification",
                    0.58 + 0.02 * i / len(targets),
                    f"aesthetics {i}/{len(targets)}",
                )

    # ---- 5. asset render ----
    progress("render", 0.6, "rendering assets")
    used_names: set[str] = set()

    def unique_name(base: str) -> str:
        name, n = base, 2
        while name in used_names:
            name = f"{base}_{n}"
            n += 1
        used_names.add(name)
        return name

    type_counts: dict[str, int] = {}
    for rec in seg_records:
        t = rec["type"]
        folder = FOLDER_BY_TYPE.get(t)
        prefix = TYPE_PREFIX[t]
        type_counts[prefix] = type_counts.get(prefix, 0) + 1

        root_midi = None
        f0 = rec["features"].get("f0MedianHz")
        if f0:
            root_midi = int(round(librosa.hz_to_midi(f0)))

        note_part = (
            f"_{midi_to_note_name(root_midi)}"
            if root_midi is not None and t in ("MelodicOneShot", "WavetableCandidate", "BassOneShot")
            else ""
        )
        stem_part = f"{rec['track']['stem']}_" if rec["track"]["stem"] else ""
        name = unique_name(f"{stem_part}{prefix}{note_part}_{type_counts[prefix]:03d}")
        rec["name"] = name

        rendered_path = None
        if folder:
            rendered_path = f"{folder}/{name}.wav"
            out = project_dir / rendered_path
            out.parent.mkdir(parents=True, exist_ok=True)
            sf.write(
                out,
                rec["track"]["channels"][:, rec["start"] : rec["end"]].T,
                sr,
                subtype="PCM_16",
            )

        clap_tags = rec["features"].get("clapTags") or []
        assets_json.append(
            {
                "id": rec["assetId"],
                "segmentId": rec["segId"],
                "type": t,
                "tags": [t2["tag"] for t2 in clap_tags],
                "renderedPath": rendered_path,
                "rootMidi": root_midi,
                "rootNote": midi_to_note_name(root_midi) if root_midi is not None else None,
                "pitchHz": f0,
                "bpm": bpm,
                "key": key,
                "confidence": rec["confidence"],
                "uncertain": rec["confidence"] < 0.6,
            }
        )

    asset_by_id = {a["id"]: a for a in assets_json}

    # ---- 6. wavetable 生成 ----
    # 実楽曲では segment 全体の分類が Phrase に寄るため、候補は
    # 「f0 が取れた全 segment」に広げ、安定区間検出 (extract_wavetable 内) に
    # 成否を委ねる (docs 07 §11-A: pitch stable region detection)。
    progress("wavetable", 0.7, "generating wavetables")
    wt_dir = project_dir / "wavetables"
    candidates = sorted(
        (
            r
            for r in seg_records
            if r["type"] != "Reject"
            and r["features"].get("f0MedianHz")
            # pyin の voiced_prob は実楽曲で 0.3〜0.45 程度に留まるため閾値は低め
            and (r["features"].get("f0Confidence") or 0) > 0.2
            and r["features"]["durationSec"] > 0.08
        ),
        key=lambda r: -(r["features"].get("f0Confidence") or 0),
    )[: MAX_WAVETABLES * 3]
    wt_count = 0
    for rec in candidates:
        if wt_count >= MAX_WAVETABLES:
            break
        seg_mono = rec["track"]["mono"][rec["start"] : rec["end"]]
        try:
            wt = extract_wavetable(seg_mono, sr, "wt")
        except WavetableError:
            continue
        wt_count += 1
        wt.name = sanitize(f"wt_{midi_to_note_name(wt.root_midi)}_{wt_count:03d}")
        write_zwt(wt, wt_dir, source_asset_id=rec["assetId"])
        sf.write(
            wt_dir / f"{wt.name}.wav", wt.samples.reshape(-1), 48000, subtype="FLOAT"
        )
        seg = next(s for s in segments_json if s["id"] == rec["segId"])
        asset_by_id[rec["assetId"]]["wavetable"] = {
            "path": f"wavetables/{wt.name}.zwt.json",
            "frameLen": FRAME_LEN,
            "frames": FRAMES,
            "sampleFormat": "f32le",
            "rootNote": midi_to_note_name(wt.root_midi),
            "rootMidi": wt.root_midi,
            "sourcePitchHz": wt.source_pitch_hz,
            "generatedFrom": {
                "segmentId": rec["segId"],
                "startSec": seg["startSec"],
                "endSec": seg["endSec"],
                "method": "pitch_stable_region",
            },
            "quality": wt.quality,
        }

    # ---- 7. drone loop 生成 ----
    progress("drone", 0.8, "searching drone loops")
    long_segs = sorted(
        (
            r
            for r in seg_records
            if r["type"] in ("DroneLoop", "NoiseTexture", "AmbienceLoop")
            and r["features"]["durationSec"] > 3.0
        ),
        key=lambda r: -r["features"]["durationSec"],
    )[:MAX_DRONES]
    for rec in long_segs:
        seg_mono = rec["track"]["mono"][rec["start"] : rec["end"]]
        loop = find_best_loop(
            seg_mono, sr, rec["features"].get("spectralFlatnessMean") or 0.2
        )
        if loop is None:
            continue
        rendered = render_loop(seg_mono, sr, loop)
        loop_name = sanitize(f"{rec['name']}_loop")
        loop_rel = f"drones/{loop_name}.wav"
        (project_dir / "drones").mkdir(parents=True, exist_ok=True)
        sf.write(project_dir / loop_rel, rendered, sr, subtype="PCM_16")
        asset_by_id[rec["assetId"]]["loop"] = {
            "enabled": True,
            "startSec": (rec["start"] + loop.start) / sr,
            "endSec": (rec["start"] + loop.end) / sr,
            "startSample": int(rec["start"] + loop.start),
            "endSample": int(rec["start"] + loop.end),
            "crossfadeMs": loop.crossfade_ms,
            "score": loop.score,
            "method": "auto_mfcc",
        }
        asset_by_id[rec["assetId"]]["renderedPath"] = loop_rel

    # ---- 8. MIDI 化 (Basic Pitch) ----
    if avail["basicPitch"]:
        progress("midi", 0.9, "Basic Pitch transcription")
        from ..models import basicpitch_worker

        phrase_recs = sorted(
            (
                r
                for r in seg_records
                if r["type"] in ("MelodicPhrase", "VocalChop")
                and r["features"]["durationSec"] >= 1.0
            ),
            key=lambda r: -r["features"]["durationSec"],
        )[:MAX_MIDI]
        midi_dir = project_dir / "midi"
        for rec in phrase_recs:
            seg_mono = rec["track"]["mono"][rec["start"] : rec["end"]]
            try:
                info = basicpitch_worker.transcribe(
                    seg_mono, sr, midi_dir / f"{rec['name']}.mid", project_dir / "tmp"
                )
            except Exception as e:  # MIDI は optional output
                log.warning("basic-pitch failed: %s", e)
                break
            if info:
                info["path"] = f"midi/{info['path']}"
                asset_by_id[rec["assetId"]]["midi"] = info

    # ---- 9. manifest ----
    progress("manifest", 0.97, "writing manifest")
    manifest = {
        "version": "0.1",
        "projectId": project_dir.name,
        "name": Path(original_filename).stem,
        "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "sources": [
            {
                "id": "src_001",
                "originalName": original_filename,
                "originalPath": f"source/{original_filename}",
                "masterPath": "source/master.wav",
                "durationSec": duration_sec,
                "sampleRate": sr,
                "channels": int(channels.shape[0]),
            }
        ],
        "derivedTracks": [
            {
                "id": t["id"],
                "sourceId": "src_001",
                "kind": t["kind"],
                "wavPath": t["wavPath"],
                **({"modelName": t["modelName"]} if t.get("modelName") else {}),
            }
            for t in tracks
        ],
        "segments": segments_json,
        "assets": assets_json,
        "arrangements": [],
    }

    import json

    manifest = _json_safe(manifest)
    (project_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False, allow_nan=False),
        encoding="utf-8",
    )
    progress("done", 1.0, "complete")
    return manifest
