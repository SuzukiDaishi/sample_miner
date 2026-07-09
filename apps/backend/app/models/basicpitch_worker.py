"""Basic Pitch による phrase → MIDI 化 (docs 03 §9)。
MIDI は optional output で必ず confidence を持つ (docs 07 §7)。
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf


def transcribe(y: np.ndarray, sr: int, midi_path: Path, tmp_dir: Path) -> dict | None:
    """mono buffer → .mid 書き出し + MidiInfo dict。note が無ければ None。"""
    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import predict

    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp_wav = tmp_dir / f"_bp_{midi_path.stem}.wav"
    sf.write(tmp_wav, y, sr)
    try:
        _model_output, midi_data, note_events = predict(
            str(tmp_wav), ICASSP_2022_MODEL_PATH
        )
    finally:
        tmp_wav.unlink(missing_ok=True)

    if not note_events:
        return None

    midi_path.parent.mkdir(parents=True, exist_ok=True)
    midi_data.write(str(midi_path))

    # note_events: (start, end, pitch, amplitude, pitch_bends)
    amplitudes = [ev[3] for ev in note_events]
    return {
        "path": midi_path.name,
        "confidence": float(np.mean(amplitudes)),
        "noteCount": len(note_events),
        "method": "basic_pitch",
    }
