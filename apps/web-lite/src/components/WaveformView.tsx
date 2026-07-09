import { useEffect, useMemo, useRef, useState } from "react";
import { useMinerStore } from "../state/store";
import { addManualOnset, removeOnset, playRegion } from "../state/actions";
import { stopPlayback } from "../audio/playback";

const CANVAS_W = 1600;
const CANVAS_H = 150;

/** mono 波形の min/max peak を CANVAS_W 本にまとめる。 */
function computePeaks(mono: Float32Array): { min: Float32Array; max: Float32Array } {
  const min = new Float32Array(CANVAS_W);
  const max = new Float32Array(CANVAS_W);
  const samplesPerPx = mono.length / CANVAS_W;
  for (let x = 0; x < CANVAS_W; x++) {
    const start = Math.floor(x * samplesPerPx);
    const end = Math.min(mono.length, Math.ceil((x + 1) * samplesPerPx));
    let lo = 0;
    let hi = 0;
    for (let i = start; i < end; i++) {
      const v = mono[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[x] = lo;
    max[x] = hi;
  }
  return { min, max };
}

export function WaveformView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mono = useMinerStore((s) => s.mono);
  const decoded = useMinerStore((s) => s.decoded);
  const onsets = useMinerStore((s) => s.onsets);
  const assets = useMinerStore((s) => s.assets);
  const selectedAssetId = useMinerStore((s) => s.selectedAssetId);
  const region = useMinerStore((s) => s.region);
  const setRegion = useMinerStore((s) => s.setRegion);
  const selectAsset = useMinerStore((s) => s.selectAsset);

  const [dragStart, setDragStart] = useState<number | null>(null);

  const peaks = useMemo(() => (mono ? computePeaks(mono) : null), [mono]);

  const totalSamples = mono?.length ?? 1;
  const xToSample = (x: number, rect: DOMRect) =>
    Math.round(((x - rect.left) / rect.width) * totalSamples);
  const sampleToX = (s: number) => (s / totalSamples) * CANVAS_W;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks) return;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // region ハイライト
    if (region) {
      ctx.fillStyle = "rgba(77,163,255,0.15)";
      const x0 = sampleToX(region.startSample);
      const x1 = sampleToX(region.endSample);
      ctx.fillRect(x0, 0, x1 - x0, CANVAS_H);
    }

    // 選択 asset ハイライト
    const sel = assets.find((a) => a.id === selectedAssetId);
    if (sel) {
      ctx.fillStyle = "rgba(255,180,84,0.12)";
      const x0 = sampleToX(sel.startSample);
      const x1 = sampleToX(sel.endSample);
      ctx.fillRect(x0, 0, x1 - x0, CANVAS_H);
    }

    // 波形
    ctx.strokeStyle = "#5f9ee8";
    ctx.beginPath();
    const mid = CANVAS_H / 2;
    for (let x = 0; x < CANVAS_W; x++) {
      ctx.moveTo(x + 0.5, mid - peaks.max[x] * mid * 0.95);
      ctx.lineTo(x + 0.5, mid - peaks.min[x] * mid * 0.95 + 1);
    }
    ctx.stroke();

    // onset markers
    ctx.strokeStyle = "rgba(255,180,84,0.8)";
    for (const o of onsets) {
      const x = sampleToX(o);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, CANVAS_H);
      ctx.stroke();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peaks, onsets, region, assets, selectedAssetId]);

  if (!mono || !decoded) return null;

  return (
    <div className="waveform-wrap">
      <canvas
        ref={canvasRef}
        width={CANVAS_W}
        height={CANVAS_H}
        onMouseDown={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const s = xToSample(e.clientX, rect);
          if (e.shiftKey) {
            addManualOnset(s);
            return;
          }
          setDragStart(s);
        }}
        onMouseMove={(e) => {
          if (dragStart === null) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const s = xToSample(e.clientX, rect);
          const start = Math.max(0, Math.min(dragStart, s));
          const end = Math.min(totalSamples, Math.max(dragStart, s));
          if (end - start > 256) {
            setRegion({ startSample: start, endSample: end });
          }
        }}
        onMouseUp={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const s = xToSample(e.clientX, rect);
          if (dragStart !== null && Math.abs(s - dragStart) <= 256) {
            // クリック: region 解除 + その位置の slice を選択
            setRegion(null);
            const hit = assets.find(
              (a) => s >= a.startSample && s < a.endSample
            );
            selectAsset(hit ? hit.id : null);
          }
          setDragStart(null);
        }}
        onDoubleClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const s = xToSample(e.clientX, rect);
          removeOnset(s, Math.round(totalSamples * 0.005));
        }}
      />
      <p className="waveform-hint">
        ドラッグ: region 選択 / クリック: slice 選択・region 解除 / Shift+クリック:
        マーカー追加 / ダブルクリック: 最寄りマーカー削除
        {region && (
          <>
            {" — region: "}
            {(region.startSample / decoded.sampleRate).toFixed(2)}s〜
            {(region.endSample / decoded.sampleRate).toFixed(2)}s{" "}
            <button onClick={playRegion}>▶ region</button>{" "}
            <button onClick={stopPlayback}>■</button>
          </>
        )}
      </p>
    </div>
  );
}
