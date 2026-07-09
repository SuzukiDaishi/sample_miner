/**
 * Analysis Worker: mono buffer を受け取り
 * onset → slice → features → classify を一括実行して返す。
 */
import { detectOnsets, DEFAULT_ONSET_CONFIG } from "../analysis/onset";
import { buildSlices, DEFAULT_SLICE_CONFIG } from "../analysis/slice";
import { computeFeatures, type SliceFeatures } from "../analysis/features";
import { classify, classificationConfidence } from "../analysis/classify";
import type { AssetType } from "../manifest/schema";

export type AnalyzeRequest = {
  type: "analyze";
  mono: Float32Array;
  sampleRate: number;
  /** 手動マーカー(サンプル位置)。指定時は onset 自動検出を置き換える。 */
  manualOnsets?: number[];
};

export type AnalyzedSlice = {
  id: string;
  startSample: number;
  endSample: number;
  onsetSample: number;
  features: SliceFeatures;
  assetType: AssetType;
  confidence: number;
};

export type AnalyzeProgress = {
  type: "progress";
  stage: "onset" | "features";
  done: number;
  total: number;
};

export type AnalyzeResponse = {
  type: "result";
  slices: AnalyzedSlice[];
  onsets: number[];
};

self.onmessage = (e: MessageEvent<AnalyzeRequest>) => {
  const msg = e.data;
  if (msg.type !== "analyze") return;

  const { mono, sampleRate } = msg;

  (self as unknown as Worker).postMessage({
    type: "progress",
    stage: "onset",
    done: 0,
    total: 1,
  } satisfies AnalyzeProgress);

  const onsets =
    msg.manualOnsets ?? detectOnsets(mono, sampleRate, DEFAULT_ONSET_CONFIG);
  const slices = buildSlices(mono, sampleRate, onsets, DEFAULT_SLICE_CONFIG);

  const analyzed: AnalyzedSlice[] = [];
  for (let i = 0; i < slices.length; i++) {
    const s = slices[i];
    const seg = mono.subarray(s.startSample, s.endSample);
    const features = computeFeatures(seg, sampleRate);
    const assetType = classify(features);
    analyzed.push({
      ...s,
      features,
      assetType,
      confidence: classificationConfidence(assetType, features),
    });
    (self as unknown as Worker).postMessage({
      type: "progress",
      stage: "features",
      done: i + 1,
      total: slices.length,
    } satisfies AnalyzeProgress);
  }

  (self as unknown as Worker).postMessage({
    type: "result",
    slices: analyzed,
    onsets,
  } satisfies AnalyzeResponse);
};
