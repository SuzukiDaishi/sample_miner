"""Layer D (docs 08 §3.4 / Phase C3) のユニットテスト。torch 無しで通ること。"""
import json

import numpy as np
import pytest

from app.models.aesthetics_worker import normalize_aesthetics
from app.pipeline import ranker
from app.pipeline.curate import (
    blend_aesthetics,
    blend_personal,
    catchiness_for_asset,
)
from app.pipeline.features import compute_features

SR = 44100


def click(dur: float = 0.4) -> np.ndarray:
    out = np.zeros(int(dur * SR), dtype=np.float32)
    n = int(0.05 * SR)
    t = np.arange(n)
    out[:n] = np.exp(-t / (0.005 * SR)) * np.sin(2 * np.pi * 3000 * t / SR) * 0.9
    return out


class TestNormalizeAesthetics:
    def test_clip_and_midpoint(self):
        assert normalize_aesthetics(1.0, 1.0) == 0.0
        assert normalize_aesthetics(10.0, 10.0) == 1.0
        assert abs(normalize_aesthetics(5.0, 5.0) - 0.5) < 1e-9

    def test_monotonic(self):
        assert normalize_aesthetics(6.0, 5.0) > normalize_aesthetics(4.0, 5.0)
        assert normalize_aesthetics(5.0, 6.0) > normalize_aesthetics(5.0, 4.0)


class TestBlends:
    def test_missing_feature_passthrough(self):
        assert blend_aesthetics(0.5, {}, []) == 0.5
        assert blend_personal(0.5, {}, []) == 0.5

    def test_weight_bounds_and_reasons(self):
        reasons: list[str] = []
        # 満点でも重み分しか動かない
        assert blend_aesthetics(0.5, {"aesScore": 1.0}, reasons) <= 0.5 + 0.16
        assert any("美的評価" in r for r in reasons)
        reasons2: list[str] = []
        assert blend_personal(0.5, {"personalScore": 1.0}, reasons2) <= 0.5 + 0.21
        assert any("好み" in r for r in reasons2)

    def test_wired_into_catchiness_for_asset(self):
        # click の catchiness は 1.0 に張り付くため、低スコアを blend して
        # 下がることで配線を確認する
        y = click()
        feats = compute_features(y, SR)
        base, _ = catchiness_for_asset(y, SR, feats, "PercussiveOneShot")
        lowered, _ = catchiness_for_asset(
            y, SR, dict(feats, aesScore=0.0, personalScore=0.0), "PercussiveOneShot"
        )
        assert lowered < base
        # 両 blend が独立に効く (aes 0.15 + personal 0.2)
        assert lowered == pytest.approx(base * 0.85 * 0.8)


class TestRanker:
    def _separable_data(self, n=60, d=16, seed=7):
        rng = np.random.default_rng(seed)
        X = rng.normal(size=(n, d))
        true_w = rng.normal(size=d)
        y = (X @ true_w > 0).astype(np.float64)
        return X, y

    def test_train_separates(self):
        X, y = self._separable_data()
        w, b = ranker.train_logreg(X, y)
        p = np.asarray(ranker.predict_proba(X, w, b))
        assert ((p >= 0.5) == (y == 1)).mean() > 0.9
        assert np.all((p > 0) & (p < 1))

    def test_l2_shrinks_weights(self):
        X, y = self._separable_data()
        w_small, _ = ranker.train_logreg(X, y, l2=0.01)
        w_big, _ = ranker.train_logreg(X, y, l2=100.0)
        assert np.linalg.norm(w_big) < np.linalg.norm(w_small)

    def test_predict_single_vector(self):
        X, y = self._separable_data()
        w, b = ranker.train_logreg(X, y)
        p = ranker.predict_proba(X[0], w, b)
        assert isinstance(p, float) and 0 < p < 1

    def test_save_load_roundtrip(self, tmp_path):
        X, y = self._separable_data()
        w, b = ranker.train_logreg(X, y)
        path = tmp_path / "weights.json"
        ranker.save_weights(path, w, b, {"nSamples": len(y), "nKeep": int(y.sum())})
        loaded = ranker.load_weights(path)
        assert loaded is not None
        assert loaded["dim"] == X.shape[1]
        p1 = np.asarray(ranker.predict_proba(X, w, b))
        p2 = np.asarray(ranker.predict_proba(X, loaded["w"], loaded["b"]))
        np.testing.assert_allclose(p1, p2, atol=1e-9)

    def test_load_missing_or_corrupt(self, tmp_path):
        assert ranker.load_weights(tmp_path / "nope.json") is None
        bad = tmp_path / "bad.json"
        bad.write_text("{not json", encoding="utf-8")
        assert ranker.load_weights(bad) is None


class TestRatingApi:
    @pytest.fixture()
    def client(self, tmp_path, monkeypatch):
        from fastapi.testclient import TestClient

        import app.main as main

        monkeypatch.setattr(main, "PROJECTS_DIR", tmp_path)
        project = tmp_path / "project_test"
        project.mkdir()
        manifest = {
            "version": "0.1",
            "assets": [
                {"id": "asset_001", "type": "PercussiveOneShot", "confidence": 0.8},
                {"id": "asset_002", "type": "MelodicPhrase", "confidence": 0.6},
            ],
        }
        (project / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False), encoding="utf-8"
        )
        return TestClient(main.app), project

    def test_keep_then_clear(self, client):
        c, project = client
        r = c.post(
            "/api/projects/project_test/assets/asset_001/rating",
            json={"rating": "keep"},
        )
        assert r.status_code == 200 and r.json()["rating"] == "keep"
        saved = json.loads((project / "manifest.json").read_text(encoding="utf-8"))
        assert saved["assets"][0]["userRating"] == "keep"
        assert "userRating" not in saved["assets"][1]

        r = c.post(
            "/api/projects/project_test/assets/asset_001/rating",
            json={"rating": None},
        )
        assert r.status_code == 200
        saved = json.loads((project / "manifest.json").read_text(encoding="utf-8"))
        assert "userRating" not in saved["assets"][0]

    def test_error_cases(self, client, tmp_path):
        c, _ = client
        r = c.post(
            "/api/projects/project_test/assets/asset_001/rating",
            json={"rating": "meh"},
        )
        assert r.status_code == 400
        r = c.post(
            "/api/projects/project_test/assets/asset_999/rating",
            json={"rating": "keep"},
        )
        assert r.status_code == 404
        (tmp_path / "project_empty").mkdir()
        r = c.post(
            "/api/projects/project_empty/assets/asset_001/rating",
            json={"rating": "keep"},
        )
        assert r.status_code == 409
