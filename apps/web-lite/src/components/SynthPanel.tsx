import { useEffect, useRef, useState } from "react";
import { useMinerStore } from "../state/store";
import {
  extractWavetableFromSelection,
  sendWavetableToSynth,
} from "../state/actions";
import { previewSynth } from "../synth/synth";
import { exportZwt } from "../synth/zwt-export";
import { downloadBytes } from "../manifest/export";
import { midiToNoteName } from "../analysis/yin";
import { FRAME_LEN } from "../analysis/wavetable-extract";

/** PC キーボード → C4 からの semitone */
const KEY_MAP: Record<string, number> = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11,
  k: 12, o: 13, l: 14, p: 15, ";": 16,
};
const BASE_MIDI = 60;

const WHITE_SEMIS = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23, 24];
const BLACK_AFTER: Record<number, number> = {
  0: 1, 2: 3, 5: 6, 7: 8, 9: 10, 12: 13, 14: 15, 17: 18, 19: 20, 21: 22,
};

function FrameView({ samples, frames }: { samples: Float32Array; frames: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const frameH = h / frames;
    for (let f = 0; f < frames; f++) {
      const frame = samples.subarray(f * FRAME_LEN, (f + 1) * FRAME_LEN);
      const mid = frameH * f + frameH / 2;
      ctx.strokeStyle = `hsl(${210 + f * 12}, 70%, 60%)`;
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const i = Math.floor((x / w) * FRAME_LEN);
        const y = mid - frame[i] * frameH * 0.45;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }, [samples, frames]);
  return <canvas ref={ref} width={340} height={160} className="frame-canvas" />;
}

export function SynthPanel() {
  const wavetables = useMinerStore((s) => s.wavetables);
  const activeWavetableId = useMinerStore((s) => s.activeWavetableId);
  const [wtPos, setWtPos] = useState(0);
  const [heldKeys, setHeldKeys] = useState<Set<number>>(new Set());
  const [message, setMessage] = useState<string | null>(null);

  const active = wavetables.find((w) => w.id === activeWavetableId) ?? null;

  // PC キーボード演奏
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "SELECT") return;
      const semi = KEY_MAP[e.key.toLowerCase()];
      if (semi === undefined) return;
      const midi = BASE_MIDI + semi;
      void previewSynth.ensureStarted().then(() => previewSynth.noteOn(midi));
      setHeldKeys((s) => new Set(s).add(midi));
    };
    const up = (e: KeyboardEvent) => {
      const semi = KEY_MAP[e.key.toLowerCase()];
      if (semi === undefined) return;
      const midi = BASE_MIDI + semi;
      previewSynth.noteOff(midi);
      setHeldKeys((s) => {
        const n = new Set(s);
        n.delete(midi);
        return n;
      });
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  const pressKey = (midi: number) => {
    void previewSynth.ensureStarted().then(() => previewSynth.noteOn(midi));
    setHeldKeys((s) => new Set(s).add(midi));
  };
  const releaseKey = (midi: number) => {
    previewSynth.noteOff(midi);
    setHeldKeys((s) => {
      const n = new Set(s);
      n.delete(midi);
      return n;
    });
  };

  return (
    <div className="synth-row">
      <div className="wt-list">
        <div className="row" style={{ display: "flex", gap: 6 }}>
          <button
            className="primary"
            onClick={async () => {
              setMessage(null);
              const err = await extractWavetableFromSelection();
              if (err) setMessage(err);
            }}
          >
            Extract Wavetable from Selection
          </button>
        </div>
        {message && <p className="error-msg">{message}</p>}
        {wavetables.length === 0 && (
          <p style={{ color: "var(--fg-dim)" }}>
            wavetable がありません。波形上で pitch の安定した region を選択して
            Extract してください。
          </p>
        )}
        {wavetables.map((wt) => (
          <div
            key={wt.id}
            className={`wt-item${wt.id === activeWavetableId ? " active" : ""}`}
          >
            <span style={{ flex: 1 }}>
              {wt.name} ({midiToNoteName(wt.rootNote)})
            </span>
            <button onClick={() => void sendWavetableToSynth(wt.id)}>
              Send to Synth
            </button>
            <button
              onClick={() => {
                const z = exportZwt(wt, wt.sourceAssetId);
                downloadBytes(z.jsonBytes, z.jsonName, "application/json");
                downloadBytes(z.binBytes, z.binName);
              }}
              title=".zwt export (json + f32)"
            >
              .zwt
            </button>
          </div>
        ))}
      </div>

      <div>
        {active ? (
          <>
            <div style={{ marginBottom: 4, fontSize: 12 }}>
              {active.name} — root {midiToNoteName(active.rootNote)} / conf{" "}
              {(active.quality.pitchConfidence * 100).toFixed(0)}% / stab{" "}
              {active.quality.pitchStabilityCents.toFixed(1)}¢
            </div>
            <FrameView samples={active.samples} frames={active.frames} />
          </>
        ) : (
          <p style={{ color: "var(--fg-dim)" }}>wavetable 未ロード</p>
        )}
      </div>

      <div>
        <div style={{ marginBottom: 6 }}>
          <label style={{ fontSize: 12 }}>
            WT Pos{" "}
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={wtPos}
              onChange={(e) => {
                const v = Number(e.target.value);
                setWtPos(v);
                previewSynth.setWtPos(v);
              }}
            />
          </label>
        </div>
        <div className="keyboard">
          {WHITE_SEMIS.map((semi) => {
            const midi = BASE_MIDI + semi;
            const blackSemi = BLACK_AFTER[semi];
            return (
              <span key={semi} style={{ display: "flex" }}>
                <div
                  className={`key${heldKeys.has(midi) ? " down" : ""}`}
                  onMouseDown={() => pressKey(midi)}
                  onMouseUp={() => releaseKey(midi)}
                  onMouseLeave={() => heldKeys.has(midi) && releaseKey(midi)}
                >
                  {midiToNoteName(midi)}
                </div>
                {blackSemi !== undefined && (
                  <div
                    className={`key black${heldKeys.has(BASE_MIDI + blackSemi) ? " down" : ""}`}
                    onMouseDown={() => pressKey(BASE_MIDI + blackSemi)}
                    onMouseUp={() => releaseKey(BASE_MIDI + blackSemi)}
                    onMouseLeave={() =>
                      heldKeys.has(BASE_MIDI + blackSemi) &&
                      releaseKey(BASE_MIDI + blackSemi)
                    }
                  />
                )}
              </span>
            );
          })}
        </div>
        <p className="waveform-hint">
          PC キーボード: A〜; で演奏 (A = C4)
        </p>
      </div>
    </div>
  );
}
