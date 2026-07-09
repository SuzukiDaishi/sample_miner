"""DSP コアのユニットテスト(合成信号)。"""
import numpy as np
import pytest

from app.pipeline.classify import classify
from app.pipeline.features import compute_features
from app.pipeline.loops import find_best_loop, render_loop
from app.pipeline.segment import segment_track
from app.pipeline.wavetable import (
    FRAME_LEN,
    FRAMES,
    WavetableError,
    extract_wavetable,
)

SR = 44100


def sine(freq: float, dur: float, amp: float = 0.8) -> np.ndarray:
    t = np.arange(int(dur * SR)) / SR
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def saw(freq: float, dur: float, amp: float = 0.8) -> np.ndarray:
    t = np.arange(int(dur * SR)) / SR
    return (amp * (2 * ((freq * t) % 1) - 1)).astype(np.float32)


def click_train(times: list[float], dur: float) -> np.ndarray:
    out = np.zeros(int(dur * SR), dtype=np.float32)
    n = int(0.05 * SR)
    t = np.arange(n)
    burst = np.exp(-t / (0.005 * SR)) * np.sin(2 * np.pi * 3000 * t / SR) * 0.9
    for tt in times:
        s = int(tt * SR)
        e = min(len(out), s + n)
        out[s:e] += burst[: e - s]
    return out


class TestSegment:
    def test_click_train_segments(self):
        y = click_train([0.5, 1.0, 1.5], 2.0)
        segs = segment_track(y, SR, "drums")
        assert len(segs) == 3
        for seg, expected in zip(segs, [0.5, 1.0, 1.5]):
            assert abs(seg.start / SR - expected) < 0.05

    def test_silence_returns_empty(self):
        assert segment_track(np.zeros(SR, dtype=np.float32), SR, "drums") == []

    def test_no_onset_returns_whole(self):
        y = sine(220, 3.0)
        segs = segment_track(y, SR, "other")
        assert len(segs) >= 1


class TestFeaturesClassify:
    def test_click_is_percussive(self):
        f = compute_features(click_train([0.005], 0.4), SR)
        assert f["attackMs"] < 35
        assert classify(f) == "PercussiveOneShot"

    def test_stable_tone_is_wavetable_candidate(self):
        f = compute_features(sine(330, 1.0), SR)
        assert f["f0Confidence"] > 0.5
        assert abs(f["f0MedianHz"] - 330) < 3
        assert classify(f) == "WavetableCandidate"

    def test_silence_is_reject(self):
        f = compute_features(np.zeros(SR, dtype=np.float32), SR)
        assert classify(f) == "Reject"

    def test_stem_hints(self):
        f = compute_features(click_train([0.005], 0.4), SR)
        assert classify(f, stem="drums") == "PercussiveOneShot"
        fv = compute_features(sine(220, 0.8), SR)
        assert classify(fv, stem="vocals") == "VocalChop"


class TestWavetable:
    def test_saw_extraction(self):
        wt = extract_wavetable(saw(110, 1.0), SR, "test")
        assert wt.samples.shape == (FRAMES, FRAME_LEN)
        assert wt.root_midi == 45  # A2

        for frame in wt.samples:
            peak = float(np.abs(frame).max())
            assert 0.9 < peak <= 1.001
            assert abs(float(frame.mean())) < 0.01  # DC 除去

            mag = np.abs(np.fft.rfft(frame))
            assert int(np.argmax(mag[1:64])) + 1 == 1  # 基本波が最大
            assert 0.3 < mag[2] / mag[1] < 0.7  # saw の倍音比

    def test_noise_rejected(self):
        rng = np.random.default_rng(7)
        noise = rng.uniform(-1, 1, SR).astype(np.float32)
        with pytest.raises(WavetableError):
            extract_wavetable(noise, SR, "noise")


class TestLoops:
    def test_periodic_loop_found(self):
        y = sine(200, 4.0, 0.7)
        loop = find_best_loop(y, SR, 0.05)
        assert loop is not None
        assert loop.score < 0.1
        rendered = render_loop(y, SR, loop)
        assert len(rendered) == loop.end - loop.start
        assert abs(float(rendered[-1]) - float(rendered[0])) < 0.15

    def test_too_short_returns_none(self):
        assert find_best_loop(sine(200, 0.2), SR, 0.05) is None
