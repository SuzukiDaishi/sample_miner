import { useState } from "react";
import { useMinerStore } from "../state/store";
import {
  buildLoopPlan,
  makeAssetBuffer,
  makeDroneBuffer,
  loopPlayer,
} from "../sequencer/scheduler";
import { renderArrangement } from "../sequencer/render";
import { getAudioContext } from "../audio/decode";
import { encodeWav } from "../audio/wav-encode";
import { zipSync } from "fflate";
import { downloadBytes, sanitizeName } from "../manifest/export";

/** melody step クリックで巡回する semitone 値 */
const MELODY_CYCLE: (number | null)[] = [null, 0, 3, 5, 7, 12];

export function LoopBuilderPanel() {
  const arr = useMinerStore((s) => s.arrangement);
  const assets = useMinerStore((s) => s.assets);
  const drones = useMinerStore((s) => s.drones);
  const decoded = useMinerStore((s) => s.decoded);
  const projectName = useMinerStore((s) => s.projectName);
  const setArrangement = useMinerStore((s) => s.setArrangement);
  const updateDrumLane = useMinerStore((s) => s.updateDrumLane);
  const updateMelodyLane = useMinerStore((s) => s.updateMelodyLane);
  const updatePhraseLane = useMinerStore((s) => s.updatePhraseLane);

  const [playing, setPlaying] = useState(false);
  const [rendering, setRendering] = useState(false);

  const percAssets = assets.filter(
    (a) => a.type === "PercussiveOneShot" || a.type === "Impact"
  );
  const melodicAssets = assets.filter(
    (a) =>
      a.type === "MelodicOneShot" ||
      a.type === "WavetableCandidate" ||
      a.type === "BassOneShot"
  );
  const phraseAssets = assets.filter(
    (a) =>
      a.type === "MelodicPhrase" ||
      a.type === "VocalChop" ||
      a.type === "SliceLoop"
  );

  const start = () => {
    if (!decoded) return;
    const ctx = getAudioContext();
    const plan = buildLoopPlan(arr);
    const buffers = new Map<string, AudioBuffer>();
    for (const e of plan.events) {
      if (!buffers.has(e.assetId)) {
        const a = assets.find((x) => x.id === e.assetId);
        if (a) buffers.set(e.assetId, makeAssetBuffer(ctx, decoded, a));
      }
    }
    const drone = plan.drone
      ? drones.find((d) => d.id === plan.drone!.droneId)
      : undefined;
    loopPlayer.start(plan, buffers, drone ? makeDroneBuffer(ctx, drone) : null);
    setPlaying(true);
  };

  const stop = () => {
    loopPlayer.stop();
    setPlaying(false);
  };

  const exportLoop = async () => {
    if (!decoded) return;
    setRendering(true);
    try {
      const result = await renderArrangement(arr, decoded, assets, drones);
      const files: Record<string, Uint8Array> = {
        "loop_mix.wav": encodeWav(
          result.mix.channels,
          result.mix.sampleRate,
          16
        ),
      };
      for (const stem of result.stems) {
        files[`stems/${stem.name}.wav`] = encodeWav(
          stem.channels,
          stem.sampleRate,
          16
        );
      }
      downloadBytes(
        zipSync(files, { level: 6 }),
        `${sanitizeName(projectName)}_loop.zip`,
        "application/zip"
      );
    } finally {
      setRendering(false);
    }
  };

  const stepButtons = (
    steps: boolean[],
    onToggle: (i: number, v: boolean) => void
  ) =>
    steps.map((on, i) => (
      <div
        key={i}
        className={`step${i % 4 === 0 ? " beat" : ""}${on ? " on" : ""}`}
        onClick={() => onToggle(i, !on)}
      >
        {i % 4 === 0 ? i / 4 + 1 : ""}
      </div>
    ));

  return (
    <div>
      <div className="row" style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8 }}>
        {playing ? (
          <button className="primary" onClick={stop}>
            ■ Stop
          </button>
        ) : (
          <button className="primary" onClick={start} disabled={!decoded}>
            ▶ Play Loop
          </button>
        )}
        <label>
          BPM{" "}
          <input
            type="number"
            min={40}
            max={240}
            style={{ width: 56 }}
            value={arr.bpm}
            onChange={(e) => setArrangement({ bpm: Number(e.target.value) || 120 })}
          />
        </label>
        <label>
          Bars{" "}
          <select
            value={arr.bars}
            onChange={(e) => setArrangement({ bars: Number(e.target.value) })}
          >
            <option value={4}>4</option>
            <option value={8}>8</option>
          </select>
        </label>
        <button onClick={() => void exportLoop()} disabled={rendering || !decoded}>
          {rendering ? "Rendering…" : "Render & Export zip (mix + stems)"}
        </button>
      </div>

      {arr.drumLanes.map((lane, li) => (
        <div className="seq-lane" key={li}>
          <div className="lane-head">
            <span style={{ width: 44, color: "var(--fg-dim)" }}>Drum {li + 1}</span>
            <select
              value={lane.assetId ?? ""}
              onChange={(e) =>
                updateDrumLane(li, { assetId: e.target.value || null })
              }
            >
              <option value="">—</option>
              {percAssets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          {stepButtons(lane.steps, (i, v) =>
            updateDrumLane(li, {
              steps: lane.steps.map((s, j) => (j === i ? v : s)),
            })
          )}
        </div>
      ))}

      <div className="seq-lane">
        <div className="lane-head">
          <span style={{ width: 44, color: "var(--fg-dim)" }}>Melody</span>
          <select
            value={arr.melodyLane.assetId ?? ""}
            onChange={(e) =>
              updateMelodyLane({ assetId: e.target.value || null })
            }
          >
            <option value="">—</option>
            {melodicAssets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        {arr.melodyLane.steps.map((semi, i) => (
          <div
            key={i}
            className={`step${i % 4 === 0 ? " beat" : ""}${semi !== null ? " melody-on" : ""}`}
            title="クリックで休符→0→+3→+5→+7→+12 を巡回"
            onClick={() => {
              const cur = MELODY_CYCLE.indexOf(semi);
              const next = MELODY_CYCLE[(cur + 1) % MELODY_CYCLE.length];
              updateMelodyLane({
                steps: arr.melodyLane.steps.map((s, j) => (j === i ? next : s)),
              });
            }}
          >
            {semi !== null ? (semi > 0 ? `+${semi}` : "0") : i % 4 === 0 ? i / 4 + 1 : ""}
          </div>
        ))}
      </div>

      <div className="seq-lane">
        <div className="lane-head">
          <span style={{ width: 44, color: "var(--fg-dim)" }}>Phrase</span>
          <select
            value={arr.phraseLane.assetId ?? ""}
            onChange={(e) =>
              updatePhraseLane({ assetId: e.target.value || null })
            }
          >
            <option value="">—</option>
            {phraseAssets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        {stepButtons(arr.phraseLane.steps, (i, v) =>
          updatePhraseLane({
            steps: arr.phraseLane.steps.map((s, j) => (j === i ? v : s)),
          })
        )}
      </div>

      <div className="seq-lane">
        <div className="lane-head">
          <span style={{ width: 44, color: "var(--fg-dim)" }}>Drone</span>
          <select
            value={arr.droneId ?? ""}
            onChange={(e) => setArrangement({ droneId: e.target.value || null })}
          >
            <option value="">—</option>
            {drones.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        <label style={{ fontSize: 12 }}>
          Gain {arr.droneGainDb} dB{" "}
          <input
            type="range"
            min={-30}
            max={0}
            step={1}
            value={arr.droneGainDb}
            onChange={(e) => setArrangement({ droneGainDb: Number(e.target.value) })}
          />
        </label>
      </div>
      <p className="waveform-hint">
        Drone は Drone タブで生成した loop を背景ベッドとして流します。BPM/Bars
        変更は次の Play から反映されます。
      </p>
    </div>
  );
}
