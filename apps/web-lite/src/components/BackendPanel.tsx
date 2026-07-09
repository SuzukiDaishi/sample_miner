/**
 * Full Backend 連携タブ。
 * FastAPI backend (apps/backend) へアップロード → job 進捗 → 共通 manifest を
 * 読み込んで素材を試聴 / ダウンロードする (docs 03: 同じ UI で Full の結果を読む)。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useMinerStore } from "../state/store";
import type { ProjectManifest, AudioAsset, AssetType } from "../manifest/schema";

const DEFAULT_URL = "http://localhost:8000";

type Health = {
  ok: boolean;
  models: {
    torch: boolean;
    device: string;
    demucs: boolean;
    clap: boolean;
    basicPitch: boolean;
  };
};

type JobInfo = {
  id: string;
  projectId: string;
  status: "queued" | "running" | "done" | "error";
  stage: string;
  progress: number;
  message: string;
  error: string | null;
};

type TrackInfo = {
  bpm: number;
  key: string | null;
  bars: number;
  seed: number;
  durationSec: number;
  rmsDb: number;
  materials: {
    kick: string | null;
    snare: string | null;
    hat: string | null;
    bass: string | null;
    vocals: string[];
    wavetablePad: boolean;
    drone: string | null;
  };
};

const TRACK_STEMS = ["drums", "bass", "pad", "vocal", "fx"];

const GROUP_LABELS: Partial<Record<AssetType, string>> = {
  PercussiveOneShot: "Percussive",
  VocalChop: "Vocal Chop",
  MelodicOneShot: "Melodic",
  BassOneShot: "Bass",
  WavetableCandidate: "Wavetable Candidate",
  DroneLoop: "Drone",
  NoiseTexture: "Noise",
  AmbienceLoop: "Ambience",
  MelodicPhrase: "Phrase",
};

export function BackendPanel() {
  const sourceFile = useMinerStore((s) => s.sourceFile);
  const [url, setUrl] = useState(DEFAULT_URL);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [mode, setMode] = useState("auto");
  const [job, setJob] = useState<JobInfo | null>(null);
  const [manifest, setManifest] = useState<ProjectManifest | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<{ projectId: string; hasManifest: boolean }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [trackJob, setTrackJob] = useState<JobInfo | null>(null);
  const [trackInfo, setTrackInfo] = useState<TrackInfo | null>(null);
  const [trackNonce, setTrackNonce] = useState(0);
  const [bars, setBars] = useState(16);
  const [seed, setSeed] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<number | null>(null);
  const trackPollRef = useRef<number | null>(null);

  const checkHealth = useCallback(async () => {
    setHealthError(null);
    try {
      const r = await fetch(`${url}/api/health`);
      setHealth(await r.json());
      const pr = await fetch(`${url}/api/projects`);
      setProjects(await pr.json());
    } catch {
      setHealth(null);
      setHealthError(
        "backend に接続できません。apps/backend で uvicorn を起動してください。"
      );
    }
  }, [url]);

  useEffect(() => {
    void checkHealth();
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
      if (trackPollRef.current !== null) window.clearInterval(trackPollRef.current);
    };
  }, [checkHealth]);

  const loadTrackInfo = useCallback(
    async (pid: string) => {
      try {
        const r = await fetch(`${url}/api/projects/${pid}/files/track/track_info.json`);
        setTrackInfo(r.ok ? await r.json() : null);
        setTrackNonce((n) => n + 1);
      } catch {
        setTrackInfo(null);
      }
    },
    [url]
  );

  const loadManifest = useCallback(
    async (pid: string) => {
      const r = await fetch(`${url}/api/projects/${pid}/manifest`);
      if (!r.ok) return;
      setManifest(await r.json());
      setProjectId(pid);
      setTrackJob(null);
      void loadTrackInfo(pid);
    },
    [url, loadTrackInfo]
  );

  const generateTrack = useCallback(async () => {
    if (!projectId) return;
    setTrackInfo(null);
    const form = new FormData();
    form.append("bars", String(bars));
    form.append("seed", String(seed));
    try {
      const r = await fetch(`${url}/api/projects/${projectId}/track`, {
        method: "POST",
        body: form,
      });
      if (!r.ok) throw new Error(await r.text());
      const { jobId } = await r.json();
      if (trackPollRef.current !== null) window.clearInterval(trackPollRef.current);
      trackPollRef.current = window.setInterval(async () => {
        try {
          const jr = await fetch(`${url}/api/jobs/${jobId}`);
          const j: JobInfo = await jr.json();
          setTrackJob(j);
          if (j.status === "done" || j.status === "error") {
            if (trackPollRef.current !== null)
              window.clearInterval(trackPollRef.current);
            trackPollRef.current = null;
            if (j.status === "done") void loadTrackInfo(projectId);
          }
        } catch {
          // 一時的な接続断は無視
        }
      }, 1500);
    } catch (e) {
      setHealthError(`track 生成失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [url, projectId, bars, seed, loadTrackInfo]);

  const startPolling = useCallback(
    (jobId: string) => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        try {
          const r = await fetch(`${url}/api/jobs/${jobId}`);
          const j: JobInfo = await r.json();
          setJob(j);
          if (j.status === "done" || j.status === "error") {
            if (pollRef.current !== null) window.clearInterval(pollRef.current);
            pollRef.current = null;
            if (j.status === "done") void loadManifest(j.projectId);
          }
        } catch {
          // 一時的な接続断は無視して次の poll へ
        }
      }, 2000);
    },
    [url, loadManifest]
  );

  const upload = async (file: File) => {
    setUploading(true);
    setManifest(null);
    setJob(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("mode", mode);
      const r = await fetch(`${url}/api/projects`, { method: "POST", body: form });
      if (!r.ok) throw new Error(await r.text());
      const { jobId } = await r.json();
      startPolling(jobId);
    } catch (e) {
      setHealthError(`upload 失敗: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUploading(false);
    }
  };

  const fileUrl = (path: string) =>
    `${url}/api/projects/${projectId}/files/${path}`;

  const modelBadge = (name: string, ok: boolean) => (
    <span
      key={name}
      style={{
        marginRight: 8,
        color: ok ? "var(--accent)" : "var(--fg-dim)",
        fontSize: 11,
      }}
    >
      {ok ? "●" : "○"} {name}
    </span>
  );

  return (
    <div>
      <div className="row" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <input
          type="text"
          style={{ width: 200 }}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button onClick={() => void checkHealth()}>接続確認</button>
        {health && (
          <span>
            {modelBadge(`GPU(${health.models.device})`, health.models.device === "cuda")}
            {modelBadge("Demucs", health.models.demucs)}
            {modelBadge("CLAP", health.models.clap)}
            {modelBadge("BasicPitch", health.models.basicPitch)}
          </span>
        )}
        {healthError && <span className="error-msg">{healthError}</span>}
      </div>

      <div className="row" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <label>
          Mode{" "}
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="auto">Auto</option>
            <option value="music">Music (Demucs)</option>
            <option value="field">Field Recording</option>
            <option value="voice">Voice</option>
            <option value="none">No Separation</option>
          </select>
        </label>
        <button
          className="primary"
          disabled={!health || !sourceFile || uploading}
          onClick={() => sourceFile && void upload(sourceFile)}
          title={sourceFile ? sourceFile.name : "先に音声を読み込んでください"}
        >
          現在のファイルを解析
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = "";
          }}
        />
        <button disabled={!health || uploading} onClick={() => fileRef.current?.click()}>
          別ファイルをアップロード…
        </button>
        {projects.length > 0 && (
          <label>
            過去の結果{" "}
            <select
              value=""
              onChange={(e) => e.target.value && void loadManifest(e.target.value)}
            >
              <option value="">—</option>
              {projects
                .filter((p) => p.hasManifest)
                .map((p) => (
                  <option key={p.projectId} value={p.projectId}>
                    {p.projectId}
                  </option>
                ))}
            </select>
          </label>
        )}
      </div>

      {job && job.status !== "done" && (
        <div style={{ marginBottom: 8 }}>
          {job.status === "error" ? (
            <span className="error-msg">job error: {job.error}</span>
          ) : (
            <span>
              {job.status} — {job.stage} {(job.progress * 100).toFixed(0)}%{" "}
              <span style={{ color: "var(--fg-dim)" }}>{job.message}</span>
            </span>
          )}
        </div>
      )}

      {manifest && projectId && (
        <div>
          <h3 style={{ fontSize: 12, color: "var(--accent2)" }}>
            {manifest.name} — assets {manifest.assets.length} / tracks{" "}
            {manifest.derivedTracks.length}{" "}
            <a
              href={fileUrl("manifest.json")}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent)" }}
            >
              manifest.json
            </a>
          </h3>

          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: 10,
              margin: "8px 0",
            }}
          >
            <b style={{ fontSize: 12, color: "var(--accent2)" }}>
              Track Builder — 採掘素材から曲を自動組み立て
            </b>
            <div className="row" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
              <label>
                Bars{" "}
                <select value={bars} onChange={(e) => setBars(Number(e.target.value))}>
                  <option value={4}>4</option>
                  <option value={8}>8</option>
                  <option value={16}>16</option>
                  <option value={32}>32</option>
                </select>
              </label>
              <label>
                Seed{" "}
                <input
                  type="number"
                  style={{ width: 56 }}
                  value={seed}
                  onChange={(e) => setSeed(Number(e.target.value) || 0)}
                />
              </label>
              <button
                className="primary"
                onClick={() => void generateTrack()}
                disabled={
                  trackJob?.status === "running" || trackJob?.status === "queued"
                }
              >
                ♪ 曲を生成
              </button>
              {trackJob && trackJob.status !== "done" && (
                trackJob.status === "error" ? (
                  <span className="error-msg">error: {trackJob.error?.split("\n")[0]}</span>
                ) : (
                  <span>
                    {trackJob.stage} {(trackJob.progress * 100).toFixed(0)}%…
                  </span>
                )
              )}
            </div>
            {trackInfo && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 12, marginBottom: 4 }}>
                  {trackInfo.bpm} BPM / {trackInfo.key ?? "?"} / {trackInfo.bars} 小節
                  (seed {trackInfo.seed}) — kick: {trackInfo.materials.kick ?? "—"} /
                  bass: {trackInfo.materials.bass ?? "—"} / vocal:{" "}
                  {trackInfo.materials.vocals[0] ?? "—"}
                  {trackInfo.materials.wavetablePad && " / wavetable pad"}
                </div>
                <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                  <b style={{ fontSize: 12 }}>Mix</b>
                  <audio
                    controls
                    preload="none"
                    src={`${fileUrl("track/mix.wav")}?v=${trackNonce}`}
                    style={{ height: 28 }}
                  />
                  <a
                    href={`${fileUrl("track/mix.wav")}?v=${trackNonce}`}
                    download
                    style={{ color: "var(--accent)", fontSize: 12 }}
                  >
                    download
                  </a>
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 4 }}>
                  {TRACK_STEMS.filter((s) => {
                    const m = trackInfo.materials;
                    if (s === "drums") return m.kick || m.snare || m.hat;
                    if (s === "bass") return !!m.bass;
                    if (s === "pad") return m.wavetablePad;
                    if (s === "vocal") return m.vocals.length > 0;
                    return !!m.drone;
                  }).map((s) => (
                    <span key={s} style={{ fontSize: 11 }}>
                      {s}{" "}
                      <audio
                        controls
                        preload="none"
                        src={`${fileUrl(`track/stems/${s}.wav`)}?v=${trackNonce}`}
                        style={{ height: 22, verticalAlign: "middle" }}
                      />
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {manifest.derivedTracks.length > 1 && (
            <div style={{ marginBottom: 8 }}>
              <b style={{ fontSize: 12 }}>Stems:</b>{" "}
              {manifest.derivedTracks.map(
                (t) =>
                  t.wavPath && (
                    <span key={t.id} style={{ marginRight: 12, fontSize: 12 }}>
                      {t.kind}{" "}
                      <audio controls preload="none" src={fileUrl(t.wavPath)} style={{ height: 24, verticalAlign: "middle" }} />
                    </span>
                  )
              )}
            </div>
          )}

          {(Object.keys(GROUP_LABELS) as AssetType[]).map((type) => {
            const group = manifest.assets.filter(
              (a) => a.type === type && a.renderedPath
            );
            if (group.length === 0) return null;
            return (
              <div key={type} className="asset-group">
                <h3>
                  {GROUP_LABELS[type]}{" "}
                  <span style={{ color: "var(--fg-dim)" }}>({group.length})</span>
                </h3>
                <div className="asset-cards">
                  {group.slice(0, 24).map((a: AudioAsset) => (
                    <div key={a.id} className="asset-card" style={{ cursor: "default" }}>
                      <div className="name">{a.renderedPath!.split("/").pop()}</div>
                      <div className="meta">
                        {a.rootNote && `${a.rootNote} · `}
                        {(a.confidence * 100).toFixed(0)}%
                        {a.tags.length > 0 && ` · ${a.tags[0]}`}
                      </div>
                      <audio
                        controls
                        preload="none"
                        src={fileUrl(a.renderedPath!)}
                        style={{ width: 170, height: 24 }}
                      />
                      <div style={{ fontSize: 11 }}>
                        {a.wavetable?.path && (
                          <a href={fileUrl(a.wavetable.path)} target="_blank" rel="noreferrer" style={{ color: "var(--accent)", marginRight: 8 }}>
                            .zwt
                          </a>
                        )}
                        {a.midi?.path && (
                          <a href={fileUrl(a.midi.path)} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                            .mid ({a.midi.noteCount} notes)
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
