import { describe, it, expect } from "vitest";
import { ratingRank, compareForGrid } from "../src/analysis/rating";
import { buildManifest } from "../src/manifest/export";
import { STEPS_PER_BAR, type ArrangementState, type AssetItem } from "../src/state/store";
import { computeFeatures } from "../src/analysis/features";

function emptyArrangement(): ArrangementState {
  return {
    bpm: 120,
    bars: 4,
    drumLanes: [{ assetId: null, steps: Array(STEPS_PER_BAR).fill(false) }],
    droneId: null,
    droneGainDb: -8,
    melodyLane: { assetId: null, steps: Array(STEPS_PER_BAR).fill(null) },
    phraseLane: { assetId: null, steps: Array(STEPS_PER_BAR).fill(false) },
  };
}

describe("rating (docs 08 Layer D-2)", () => {
  it("ranks keep < unrated < discard", () => {
    expect(ratingRank("keep")).toBeLessThan(ratingRank(undefined));
    expect(ratingRank(undefined)).toBeLessThan(ratingRank("discard"));
  });

  it("sorts by rating rank first, catchiness within a rank", () => {
    const items = [
      { rating: undefined, catchy: 0.9 },
      { rating: "discard" as const, catchy: 1.0 },
      { rating: "keep" as const, catchy: 0.1 },
      { rating: undefined, catchy: 0.2 },
      { rating: "keep" as const, catchy: 0.8 },
    ];
    const sorted = [...items].sort(compareForGrid);
    expect(sorted.map((i) => `${i.rating ?? "none"}:${i.catchy}`)).toEqual([
      "keep:0.8",
      "keep:0.1",
      "none:0.9",
      "none:0.2",
      "discard:1",
    ]);
  });

  it("round-trips userRating through buildManifest", () => {
    const sr = 44100;
    const mono = new Float32Array(sr);
    for (let i = 0; i < sr; i++) mono[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / sr);
    const features = computeFeatures(mono, sr);
    const base: Omit<AssetItem, "id" | "userRating"> = {
      segmentId: "seg_001",
      name: "a",
      startSample: 0,
      endSample: sr,
      onsetSample: 0,
      detectionMethod: "onset",
      features,
      type: "MelodicOneShot",
      confidence: 0.8,
      userEdited: false,
    };
    const manifest = buildManifest({
      projectName: "p",
      sourceName: "s.wav",
      decoded: null,
      assets: [
        { ...base, id: "asset_001", segmentId: "seg_001", userRating: "keep" },
        { ...base, id: "asset_002", segmentId: "seg_002", userRating: "discard" },
        { ...base, id: "asset_003", segmentId: "seg_003" },
      ],
      wavetables: [],
      drones: [],
      arrangement: emptyArrangement(),
    });
    const byId = Object.fromEntries(manifest.assets.map((a) => [a.id, a]));
    expect(byId["asset_001"].userRating).toBe("keep");
    // discard も落とさず残す (ranker の学習データ)
    expect(byId["asset_002"].userRating).toBe("discard");
    expect(byId["asset_003"].userRating).toBeUndefined();
  });
});
