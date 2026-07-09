import { useState } from "react";
import { useMinerStore } from "../state/store";
import { makeDroneLoop, playDrone } from "../state/actions";
import { stopPlayback } from "../audio/playback";
import { encodeWav } from "../audio/wav-encode";
import { downloadBytes, sanitizeName } from "../manifest/export";

export function DronePanel() {
  const drones = useMinerStore((s) => s.drones);
  const activeDroneId = useMinerStore((s) => s.activeDroneId);
  const setActiveDrone = useMinerStore((s) => s.setActiveDrone);
  const decoded = useMinerStore((s) => s.decoded);
  const [message, setMessage] = useState<string | null>(null);

  const sr = decoded?.sampleRate ?? 48000;

  return (
    <div>
      <div className="row" style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <button
          className="primary"
          onClick={() => {
            setMessage(null);
            const err = makeDroneLoop();
            if (err) setMessage(err);
          }}
        >
          Find Loop in Selection
        </button>
        <button onClick={stopPlayback}>■ Stop</button>
        {message && <span className="error-msg">{message}</span>}
      </div>

      {drones.length === 0 ? (
        <p style={{ color: "var(--fg-dim)" }}>
          drone loop がありません。長めの region か DroneLoop/NoiseTexture
          素材を選択して Find Loop してください。
        </p>
      ) : (
        <div className="wt-list" style={{ maxWidth: 560 }}>
          {drones.map((d) => (
            <div
              key={d.id}
              className={`wt-item${d.id === activeDroneId ? " active" : ""}`}
            >
              <span style={{ flex: 1 }}>
                {d.name} — {(d.loop.startSample / sr).toFixed(2)}s〜
                {(d.loop.endSample / sr).toFixed(2)}s / xfade{" "}
                {d.loop.crossfadeMs}ms / score {d.loop.score.toFixed(3)}
              </span>
              <button
                onClick={() => {
                  setActiveDrone(d.id);
                  playDrone(d.id);
                }}
              >
                ▶ Loop
              </button>
              <button
                onClick={() => {
                  const bytes = encodeWav([d.buffer], d.sampleRate, 16);
                  downloadBytes(bytes, `${sanitizeName(d.name)}.wav`, "audio/wav");
                }}
              >
                Export wav
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
