import { useState } from "react";
import { useMinerStore } from "../state/store";
import { DropZone } from "./DropZone";
import { WaveformView } from "./WaveformView";
import { SliceGrid } from "./SliceGrid";
import { AssetInspector } from "./AssetInspector";
import { SynthPanel } from "./SynthPanel";
import { DronePanel } from "./DronePanel";
import { LoopBuilderPanel } from "./LoopBuilderPanel";
import { BackendPanel } from "./BackendPanel";
import { exportAllZip, runAnalysis } from "../state/actions";

type Tab = "synth" | "drone" | "loop" | "backend";

export function App() {
  const decoded = useMinerStore((s) => s.decoded);
  const sourceName = useMinerStore((s) => s.sourceName);
  const status = useMinerStore((s) => s.analysisStatus);
  const assets = useMinerStore((s) => s.assets);
  const [tab, setTab] = useState<Tab>("synth");

  const statusText = (() => {
    switch (status.state) {
      case "idle":
        return sourceName ?? "";
      case "analyzing":
        return `解析中: ${status.stage} ${status.done}/${status.total}`;
      case "done":
        return `${sourceName} — ${assets.length} 素材 (${decoded?.durationSec.toFixed(1)}s / ${decoded?.sampleRate}Hz)`;
      case "error":
        return `エラー: ${status.message}`;
    }
  })();

  return (
    <>
      <header className="app-header">
        <h1>AI Sample Miner — Web Lite</h1>
        <DropZone compact />
        <button onClick={() => runAnalysis()} disabled={!decoded}>
          Re-analyze
        </button>
        <span className={`status${status.state === "error" ? " error-msg" : ""}`}>
          {statusText}
        </span>
        <button className="primary" onClick={exportAllZip} disabled={assets.length === 0}>
          Export All (zip)
        </button>
      </header>

      {!decoded ? (
        <DropZone />
      ) : (
        <>
          <WaveformView />
          <div className="main-row">
            <SliceGrid />
            <AssetInspector />
          </div>
        </>
      )}
      <div className="bottom-panel">
        <div className="tab-bar">
          <button
            className={tab === "synth" ? "active" : ""}
            onClick={() => setTab("synth")}
          >
            Wavetable Synth
          </button>
          <button
            className={tab === "drone" ? "active" : ""}
            onClick={() => setTab("drone")}
          >
            Drone Loop
          </button>
          <button
            className={tab === "loop" ? "active" : ""}
            onClick={() => setTab("loop")}
          >
            Loop Builder
          </button>
          <button
            className={tab === "backend" ? "active" : ""}
            onClick={() => setTab("backend")}
          >
            Full Backend
          </button>
        </div>
        <div className="tab-content">
          {tab === "synth" && <SynthPanel />}
          {tab === "drone" && <DronePanel />}
          {tab === "loop" && <LoopBuilderPanel />}
          {tab === "backend" && <BackendPanel />}
        </div>
      </div>
    </>
  );
}
