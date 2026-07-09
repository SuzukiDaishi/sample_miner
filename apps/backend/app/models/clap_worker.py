"""CLAP zero-shot タグ付け worker (docs 03 §6)。
決定には使わず ScoredTag 候補として features に付与する (docs 07 §6)。
"""
from __future__ import annotations

import numpy as np

MODEL_ID = "laion/clap-htsat-unfused"
CLAP_SR = 48000

# docs 03 §6 の CLAP prompt 例
PROMPTS = [
    "kick drum",
    "snare drum",
    "hi-hat",
    "percussion hit",
    "metal impact",
    "wood hit",
    "water sound",
    "wind noise",
    "ambient drone",
    "tonal drone",
    "sustained musical note",
    "vocal chop",
    "bass note",
    "melodic phrase",
    "noise texture",
]

_state: dict = {}


def _get_model():
    if not _state:
        import torch
        from transformers import ClapModel, ClapProcessor

        device = "cuda" if torch.cuda.is_available() else "cpu"
        model = ClapModel.from_pretrained(MODEL_ID).to(device).eval()
        processor = ClapProcessor.from_pretrained(MODEL_ID)
        with torch.no_grad():
            text_inputs = processor(text=PROMPTS, return_tensors="pt", padding=True)
            text_inputs = {k: v.to(device) for k, v in text_inputs.items()}
            text_emb = model.get_text_features(**text_inputs)
            text_emb = text_emb / text_emb.norm(dim=-1, keepdim=True)
        _state.update(model=model, processor=processor, text_emb=text_emb, device=device)
    return _state


def tag_audio(y: np.ndarray, sr: int, top_k: int = 3) -> list[dict]:
    """mono buffer → ScoredTag list [{tag, score, source: "clap"}]"""
    import torch
    import librosa

    st = _get_model()
    if sr != CLAP_SR:
        y = librosa.resample(y.astype(np.float32), orig_sr=sr, target_sr=CLAP_SR)
    # CLAP は 10 秒窓。長い素材は先頭 10 秒
    y = y[: CLAP_SR * 10]
    if len(y) < CLAP_SR // 10:
        return []

    with torch.no_grad():
        inputs = st["processor"](
            audios=[y], sampling_rate=CLAP_SR, return_tensors="pt"
        )
        inputs = {k: v.to(st["device"]) for k, v in inputs.items()}
        audio_emb = st["model"].get_audio_features(**inputs)
        audio_emb = audio_emb / audio_emb.norm(dim=-1, keepdim=True)
        logits = (audio_emb @ st["text_emb"].T)[0]
        probs = torch.softmax(logits * 20, dim=-1).cpu().numpy()

    order = np.argsort(probs)[::-1][:top_k]
    return [
        {"tag": PROMPTS[i], "score": float(probs[i]), "source": "clap"}
        for i in order
    ]
