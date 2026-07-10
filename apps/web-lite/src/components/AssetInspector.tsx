import { useState } from "react";
import { useMinerStore } from "../state/store";
import type { AssetType } from "../manifest/schema";
import {
  playAsset,
  exportAssetWav,
  extractWavetableFromSelection,
  makeDroneLoop,
} from "../state/actions";
import { stopPlayback } from "../audio/playback";
import { midiToNoteName } from "../analysis/yin";

const ALL_TYPES: AssetType[] = [
  "PercussiveOneShot",
  "MelodicOneShot",
  "BassOneShot",
  "Impact",
  "WavetableCandidate",
  "Wavetable",
  "DroneLoop",
  "NoiseTexture",
  "AmbienceLoop",
  "MelodicPhrase",
  "VocalChop",
  "SliceLoop",
  "Reject",
];

function fmt(v: number | undefined, digits = 1, unit = ""): string {
  return v === undefined ? "—" : `${v.toFixed(digits)}${unit}`;
}

export function AssetInspector() {
  const asset = useMinerStore((s) =>
    s.assets.find((a) => a.id === s.selectedAssetId)
  );
  const updateAsset = useMinerStore((s) => s.updateAsset);
  const [message, setMessage] = useState<string | null>(null);

  if (!asset) {
    return (
      <div className="inspector">
        <h2>Inspector</h2>
        <p style={{ color: "var(--fg-dim)" }}>
          素材をクリックすると詳細が表示されます。
        </p>
      </div>
    );
  }

  const f = asset.features;

  return (
    <div className="inspector">
      <h2>{asset.name}</h2>

      <div className="row">
        <button className="primary" onClick={() => playAsset(asset.id)}>
          ▶ Play
        </button>
        <button onClick={stopPlayback}>■ Stop</button>
        <button onClick={() => exportAssetWav(asset.id)}>Export wav</button>
      </div>

      {/* keep/discard 判定 (docs 08 §3.4 D-2)。再クリックで解除。
          userEdited は type/pitch 修正用フラグなのでここでは立てない */}
      <div className="row">
        <label>Rating</label>
        <button
          className={asset.userRating === "keep" ? "primary" : undefined}
          onClick={() =>
            updateAsset(asset.id, {
              userRating: asset.userRating === "keep" ? undefined : "keep",
            })
          }
        >
          ◎ Keep
        </button>
        <button
          style={
            asset.userRating === "discard"
              ? { background: "#a33", color: "#fff" }
              : undefined
          }
          onClick={() =>
            updateAsset(asset.id, {
              userRating: asset.userRating === "discard" ? undefined : "discard",
            })
          }
        >
          ✕ Discard
        </button>
      </div>

      <div className="row">
        <label>Type</label>
        <select
          value={asset.type}
          onChange={(e) =>
            updateAsset(asset.id, {
              type: e.target.value as AssetType,
              userEdited: true,
            })
          }
        >
          {ALL_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      <div className="row">
        <label>Root MIDI</label>
        <input
          type="number"
          min={0}
          max={127}
          style={{ width: 60 }}
          value={asset.rootMidi ?? ""}
          onChange={(e) => {
            const v = e.target.value === "" ? undefined : Number(e.target.value);
            updateAsset(asset.id, { rootMidi: v, userEdited: true });
          }}
        />
        <span style={{ color: "var(--fg-dim)" }}>
          {asset.rootMidi !== undefined ? midiToNoteName(asset.rootMidi) : ""}
        </span>
      </div>

      <table>
        <tbody>
          <tr>
            <td>duration</td>
            <td>{fmt(f.durationSec, 3, " s")}</td>
          </tr>
          <tr>
            <td>peak / RMS</td>
            <td>
              {fmt(f.peakDb, 1, " dB")} / {fmt(f.rmsDb, 1, " dB")}
            </td>
          </tr>
          <tr>
            <td>attack / decay</td>
            <td>
              {fmt(f.attackMs, 1, " ms")} / {fmt(f.decayMs, 0, " ms")}
            </td>
          </tr>
          <tr>
            <td>centroid</td>
            <td>{fmt(f.spectralCentroid, 0, " Hz")}</td>
          </tr>
          <tr>
            <td>flatness</td>
            <td>{fmt(f.spectralFlatness, 3)}</td>
          </tr>
          <tr>
            <td>ZCR</td>
            <td>{fmt(f.zeroCrossingRate, 4)}</td>
          </tr>
          <tr>
            <td>transient density</td>
            <td>{fmt(f.transientDensity, 2, " /s")}</td>
          </tr>
          <tr>
            <td>pitch</td>
            <td>
              {f.pitchHz !== undefined ? `${f.pitchHz.toFixed(1)} Hz` : "—"}
            </td>
          </tr>
          <tr>
            <td>pitch conf / stab</td>
            <td>
              {fmt(f.pitchConfidence, 2)} / {fmt(f.pitchStabilityCents, 1, " ¢")}
            </td>
          </tr>
          <tr>
            <td>voiced ratio</td>
            <td>{fmt(f.voicedRatio, 2)}</td>
          </tr>
          <tr>
            <td>classification conf</td>
            <td>{(asset.confidence * 100).toFixed(0)}%</td>
          </tr>
        </tbody>
      </table>

      <div className="row">
        <button
          onClick={async () => {
            setMessage(null);
            const err = await extractWavetableFromSelection();
            setMessage(err ?? "wavetable を抽出してシンセにロードしました");
          }}
        >
          Extract Wavetable
        </button>
        <button
          onClick={() => {
            setMessage(null);
            const err = makeDroneLoop();
            setMessage(err ?? "drone loop を生成しました (Drone タブ)");
          }}
        >
          Make Drone Loop
        </button>
      </div>
      {message && (
        <p className={message.includes("しました") ? "" : "error-msg"}>
          {message}
        </p>
      )}
    </div>
  );
}
