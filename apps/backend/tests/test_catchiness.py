"""キャッチーさスコアリング (docs 08 Phase C1) のユニットテスト。"""
import numpy as np

from app.pipeline.curate import (
    blend_clap,
    blend_hook,
    catchiness_for_asset,
    catchiness_oneshot,
    catchiness_phrase,
)
from app.pipeline.features import band_energy_ratio, compute_features
from app.pipeline.hooks import compute_hook_map, segment_hook_score

SR = 44100


def sine(freq: float, dur: float, amp: float = 0.8, sr: int = SR) -> np.ndarray:
    t = np.arange(int(dur * sr)) / sr
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def click(dur: float = 0.4) -> np.ndarray:
    out = np.zeros(int(dur * SR), dtype=np.float32)
    n = int(0.05 * SR)
    t = np.arange(n)
    out[:n] = np.exp(-t / (0.005 * SR)) * np.sin(2 * np.pi * 3000 * t / SR) * 0.9
    return out


class TestBandFeatures:
    def test_band_energy_ratio(self):
        assert band_energy_ratio(sine(3000, 0.5), SR, 2000, 5000) > 0.9
        assert band_energy_ratio(sine(200, 0.5), SR, 2000, 5000) < 0.05

    def test_new_features_in_compute_features(self):
        f = compute_features(click(), SR)
        assert f["crestDb"] > 8  # 減衰クリックはピーキー
        assert f["presenceRatio"] > 0.3  # 3kHz バースト
        assert f["spectralFluxMean"] >= 0.0
        fs = compute_features(sine(330, 1.0), SR)
        assert fs["crestDb"] < 6  # 正弦波の crest は約 3dB
        assert fs["pitchRangeSemitones"] is not None
        assert fs["pitchRangeSemitones"] < 1.0  # 動かないピッチ


class TestCatchiness:
    def test_punchy_click_beats_dull_thud(self):
        """明るく鋭い打撃 > こもった遅い打撃。"""
        bright = click()
        t = np.arange(int(0.4 * SR)) / SR
        dull = (
            0.5
            * np.sin(2 * np.pi * 100 * t)
            * np.minimum(1.0, t / 0.03)  # 遅い attack
            * np.exp(-t / 0.3)  # 緩い減衰
        ).astype(np.float32)
        cb, _ = catchiness_oneshot(bright, SR, compute_features(bright, SR))
        cd, _ = catchiness_oneshot(dull, SR, compute_features(dull, SR))
        assert cb > cd

    def test_moving_melody_beats_static_tone(self):
        """ピッチが動くフレーズ > 一定音のフレーズ。"""
        notes = [261.6, 329.6, 392.0, 329.6]  # C4 E4 G4 E4
        moving = np.concatenate([sine(f, 0.4) for f in notes])
        static = sine(261.6, 1.6)
        cm, _ = catchiness_phrase(moving, SR, compute_features(moving, SR))
        cs, _ = catchiness_phrase(static, SR, compute_features(static, SR))
        assert cm > cs

    def test_blend_hook(self):
        reasons: list[str] = []
        assert blend_hook(0.5, {}, reasons) == 0.5  # hookScore 無し → そのまま
        blended = blend_hook(0.5, {"hookScore": 1.0}, reasons)
        assert 0.5 < blended <= 1.0
        assert any("反復" in r for r in reasons)
        assert blend_hook(0.5, {"hookScore": 0.0}, []) < 0.5

    def test_blend_clap_is_weak_signal(self):
        reasons: list[str] = []
        assert blend_clap(0.5, {}, reasons) == 0.5  # clapCatchy 無し → そのまま
        # 重みは小さい: CLAP が満点でも +0.15 まで (docs 08 §3.3)
        assert blend_clap(0.5, {"clapCatchy": 1.0}, reasons) <= 0.5 + 0.16
        assert any("CLAP" in r for r in reasons)

    def test_catchiness_for_asset_dispatch(self):
        y = click()
        feats = compute_features(y, SR)
        c_drum, _ = catchiness_for_asset(y, SR, feats, "PercussiveOneShot")
        c_direct, _ = catchiness_oneshot(y, SR, feats)
        assert c_drum == c_direct  # blend 対象の feature が無ければ一致
        # hook + clap の blend が乗る
        feats2 = dict(feats, hookScore=1.0, clapCatchy=1.0)
        c_phrase, reasons = catchiness_for_asset(y, SR, feats2, "MelodicPhrase")
        c_base, _ = catchiness_phrase(y, SR, feats)
        assert c_phrase > c_base
        # 未知 type (drones 等) は中立 0.5 ベース
        c_drone, _ = catchiness_for_asset(y, SR, feats, "DroneLoop")
        assert abs(c_drone - 0.5) < 1e-9


class TestHookMap:
    def test_too_short_returns_none(self):
        assert compute_hook_map(sine(220, 5.0), SR) is None

    def test_repeated_motif_scores_higher_than_unique(self):
        """何度も出るモチーフ A の区間 > 1 回しか出ないモチーフ B の区間。"""
        sr = 22050

        def bar(freqs: list[float]) -> np.ndarray:
            out = []
            for f in freqs:
                y = sine(f, 0.5, sr=sr)
                n = len(y)
                env = np.exp(-np.arange(n) / (0.35 * sr)).astype(np.float32)
                out.append(y * env)
            return np.concatenate(out)

        motif_a = bar([261.6, 329.6, 392.0, 329.6])  # C4 E4 G4 E4
        motif_b = bar([185.0, 233.1, 311.1, 277.2])  # F#3 A#3 D#4 C#4
        # A×9, B×1, A×10 の 40 秒トラック (B は 18〜20 秒)
        y = np.concatenate([motif_a] * 9 + [motif_b] + [motif_a] * 10)

        hm = compute_hook_map(y, sr)
        assert hm is not None
        a_score = segment_hook_score(hm, 4.0, 8.0)
        b_score = segment_hook_score(hm, 18.0, 20.0)
        assert a_score is not None and b_score is not None
        assert a_score > b_score

    def test_uniform_track_returns_none(self):
        """完全一様な音源は反復構造が測れない → None。"""
        sr = 22050
        assert compute_hook_map(np.tile(sine(220, 1.0, sr=sr), 30), sr) is None

    def test_out_of_range_returns_none(self):
        sr = 22050
        y = np.concatenate(
            [np.concatenate([sine(f, 0.5, sr=sr) for f in (220.0, 330.0, 277.2, 415.3)])]
            * 15
        )
        hm = compute_hook_map(y, sr)
        assert hm is not None
        assert segment_hook_score(hm, 1000.0, 1001.0) is None
