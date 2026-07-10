"""CLAP zero-shot タグ付け worker (docs 03 §6)。
決定には使わず ScoredTag 候補として features に付与する (docs 07 §6)。
docs 08 §3.3: 対照プロンプトペアによるキャッチーさスコア (弱いシグナル) も返す。
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

# docs 08 §3.3: 対照ペア。単発プロンプトの類似度は絶対値が不安定だが、
# ペアの差分を取ると録音条件のバイアスが打ち消される
CATCHY_PROMPT_PAIRS = [
    ("a catchy punchy drum hit", "a weak muffled drum hit"),
    ("a memorable melodic hook", "boring background music"),
    ("a fat powerful bass sound", "a thin weak bass sound"),
    ("an expressive vocal phrase", "a dull monotone voice"),
    ("a bright clear musical sound", "a muddy unclear sound"),
]

CATCHY_LOGIT_SCALE = 20.0  # tag_audio の softmax スケールと揃える

_state: dict = {}


def _embed_text(st: dict, texts: list[str]):
    import torch

    with torch.no_grad():
        inputs = st["processor"](text=texts, return_tensors="pt", padding=True)
        inputs = {k: v.to(st["device"]) for k, v in inputs.items()}
        emb = st["model"].get_text_features(**inputs)
        return emb / emb.norm(dim=-1, keepdim=True)


def _get_model():
    if not _state:
        import torch
        from transformers import ClapModel, ClapProcessor

        device = "cuda" if torch.cuda.is_available() else "cpu"
        model = ClapModel.from_pretrained(MODEL_ID).to(device).eval()
        processor = ClapProcessor.from_pretrained(MODEL_ID)
        _state.update(model=model, processor=processor, device=device)
        _state["text_emb"] = _embed_text(_state, PROMPTS)
        _state["catchy_pos"] = _embed_text(_state, [p for p, _ in CATCHY_PROMPT_PAIRS])
        _state["catchy_neg"] = _embed_text(_state, [n for _, n in CATCHY_PROMPT_PAIRS])
    return _state


def _embed_audio(y: np.ndarray, sr: int):
    """mono buffer → 正規化済み audio embedding。短すぎる場合 None。"""
    import torch
    import librosa

    st = _get_model()
    if sr != CLAP_SR:
        y = librosa.resample(y.astype(np.float32), orig_sr=sr, target_sr=CLAP_SR)
    # CLAP は 10 秒窓。長い素材は先頭 10 秒
    y = y[: CLAP_SR * 10]
    if len(y) < CLAP_SR // 10:
        return None

    with torch.no_grad():
        inputs = st["processor"](
            audios=[y], sampling_rate=CLAP_SR, return_tensors="pt"
        )
        inputs = {k: v.to(st["device"]) for k, v in inputs.items()}
        audio_emb = st["model"].get_audio_features(**inputs)
        return audio_emb / audio_emb.norm(dim=-1, keepdim=True)


def embed_audio(y: np.ndarray, sr: int) -> np.ndarray | None:
    """mono buffer → unit-norm audio embedding (np.float32)。ranker 学習用。"""
    emb = _embed_audio(y, sr)
    if emb is None:
        return None
    return emb.cpu().numpy()[0].astype(np.float32)


def analyze_audio(y: np.ndarray, sr: int, top_k: int = 3) -> dict:
    """1 回の audio embedding で tags / catchy / embedding をまとめて返す。

    returns {"tags": ScoredTag list, "catchy": float 0..1 | None,
             "embedding": np.float32 unit-norm array | None}
    embedding は JSON 非安全なので features へは stamp しないこと
    (個人 ranker の personalScore 算出にのみ使う; docs 08 §3.4 D-2)。
    """
    import torch

    st = _get_model()
    audio_emb = _embed_audio(y, sr)
    if audio_emb is None:
        return {"tags": [], "catchy": None, "embedding": None}

    with torch.no_grad():
        logits = (audio_emb @ st["text_emb"].T)[0]
        probs = torch.softmax(logits * 20, dim=-1).cpu().numpy()
        # 対照ペア: sim(pos) - sim(neg) の差分を sigmoid でスコア化しペア平均
        pos = (audio_emb @ st["catchy_pos"].T)[0]
        neg = (audio_emb @ st["catchy_neg"].T)[0]
        delta = (pos - neg) * CATCHY_LOGIT_SCALE
        catchy = float(torch.sigmoid(delta).mean().cpu())

    order = np.argsort(probs)[::-1][:top_k]
    tags = [
        {"tag": PROMPTS[i], "score": float(probs[i]), "source": "clap"}
        for i in order
    ]
    return {
        "tags": tags,
        "catchy": catchy,
        "embedding": audio_emb.cpu().numpy()[0].astype(np.float32),
    }


def tag_audio(y: np.ndarray, sr: int, top_k: int = 3) -> list[dict]:
    """mono buffer → ScoredTag list [{tag, score, source: "clap"}]"""
    return analyze_audio(y, sr, top_k)["tags"]
