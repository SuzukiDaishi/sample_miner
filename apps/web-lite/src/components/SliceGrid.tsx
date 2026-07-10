import { useMinerStore } from "../state/store";
import { playAsset } from "../state/actions";
import { catchinessScore } from "../analysis/catchiness";
import type { AssetType } from "../manifest/schema";

const GROUP_ORDER: { type: AssetType; label: string }[] = [
  { type: "PercussiveOneShot", label: "Percussive" },
  { type: "MelodicOneShot", label: "Melodic" },
  { type: "WavetableCandidate", label: "Wavetable Candidate" },
  { type: "Wavetable", label: "Wavetable" },
  { type: "DroneLoop", label: "Drone" },
  { type: "NoiseTexture", label: "Noise / Texture" },
  { type: "AmbienceLoop", label: "Ambience" },
  { type: "MelodicPhrase", label: "Phrase" },
  { type: "VocalChop", label: "Vocal Chop" },
  { type: "BassOneShot", label: "Bass" },
  { type: "Impact", label: "Impact" },
  { type: "SliceLoop", label: "Slice Loop" },
  { type: "Reject", label: "Reject" },
];

export function SliceGrid() {
  const assets = useMinerStore((s) => s.assets);
  const selectedAssetId = useMinerStore((s) => s.selectedAssetId);
  const selectAsset = useMinerStore((s) => s.selectAsset);
  const setRegion = useMinerStore((s) => s.setRegion);
  const decoded = useMinerStore((s) => s.decoded);

  if (assets.length === 0) {
    return (
      <div className="asset-grid">
        <p style={{ color: "var(--fg-dim)" }}>まだ素材がありません。</p>
      </div>
    );
  }

  const sr = decoded?.sampleRate ?? 48000;

  return (
    <div className="asset-grid">
      {GROUP_ORDER.map(({ type, label }) => {
        // グループ内はキャッチーさ順 (docs 08): 抜け・パンチ・メロディの動きが
        // 良い素材から並べる
        const group = assets
          .filter((a) => a.type === type)
          .map((a) => ({ asset: a, catchy: catchinessScore(a.features, a.type) }))
          .sort((x, y) => y.catchy - x.catchy);
        if (group.length === 0) return null;
        return (
          <div className="asset-group" key={type}>
            <h3>
              {label} <span style={{ color: "var(--fg-dim)" }}>({group.length})</span>
            </h3>
            <div className="asset-cards">
              {group.map(({ asset: a, catchy }) => (
                <div
                  key={a.id}
                  className={`asset-card${a.id === selectedAssetId ? " selected" : ""}`}
                  onClick={() => {
                    selectAsset(a.id);
                    setRegion(null);
                    playAsset(a.id);
                  }}
                  title={`${(a.startSample / sr).toFixed(2)}s〜${(a.endSample / sr).toFixed(2)}s · キャッチーさ ${(catchy * 100).toFixed(0)}`}
                >
                  <div className="name">{a.name}</div>
                  <div className="meta">
                    {a.features.durationSec.toFixed(2)}s
                    {a.features.pitchHz !== undefined &&
                      (a.features.pitchConfidence ?? 0) > 0.5 &&
                      ` · ${a.features.pitchHz.toFixed(0)}Hz`}
                    {" · ★"}
                    {(catchy * 100).toFixed(0)}
                    {" · "}
                    {(a.confidence * 100).toFixed(0)}%
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
