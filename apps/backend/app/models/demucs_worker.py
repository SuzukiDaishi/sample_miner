"""Demucs stem 分離 worker (docs 03: htdemucs で drums/bass/vocals/other)。

PyPI の demucs 4.0.1 には `demucs.api` が無いため、pretrained + apply_model を
直接使う。demucs.audio.AudioFile は ffmpeg バイナリ依存なので音声ロードは
soundfile で行う。
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf

MODEL_NAME = "htdemucs"

_state: dict = {}


def _get_model():
    if not _state:
        import torch
        from demucs.pretrained import get_model

        device = "cuda" if torch.cuda.is_available() else "cpu"
        model = get_model(MODEL_NAME)
        model.to(device)
        model.eval()
        _state.update(model=model, device=device)
    return _state["model"], _state["device"]


def separate(master_path: Path) -> dict[str, tuple[np.ndarray, int]]:
    """master wav → {stem: (channels[ch, samples], sample_rate)}"""
    import librosa
    import torch
    from demucs.apply import apply_model

    model, device = _get_model()

    data, sr = sf.read(master_path, always_2d=True, dtype="float32")
    wav = data.T  # (ch, samples)
    if wav.shape[0] == 1:
        wav = np.repeat(wav, 2, axis=0)
    elif wav.shape[0] > 2:
        wav = wav[:2]
    if sr != model.samplerate:
        wav = librosa.resample(wav, orig_sr=sr, target_sr=model.samplerate)
        sr = model.samplerate

    t = torch.from_numpy(np.ascontiguousarray(wav))
    ref = t.mean(0)
    std = ref.std() + 1e-8
    t = (t - ref.mean()) / std

    with torch.no_grad():
        sources = apply_model(
            model, t[None], device=device, shifts=1, split=True, overlap=0.25
        )[0]
    sources = sources * std + ref.mean()

    out: dict[str, tuple[np.ndarray, int]] = {}
    for name, src in zip(model.sources, sources):
        out[name] = (src.cpu().numpy().astype(np.float32), sr)
    return out
