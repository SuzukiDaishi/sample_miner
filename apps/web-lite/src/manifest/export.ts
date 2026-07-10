/**
 * manifest.json 生成 + zip export。docs 05 の Export folder 構成:
 *   manifest.json / one_shots/ melodic/ wavetables/ drones/ phrases/
 */
import { zipSync, strToU8 } from "fflate";
import type {
  ProjectManifest,
  AudioAsset,
  Segment,
  AssetType,
  Arrangement,
} from "./schema";
import type {
  AssetItem,
  WavetableItem,
  DroneLoopItem,
  ArrangementState,
} from "../state/store";
import { STEPS_PER_BAR } from "../state/store";
import type { DecodedAudio } from "../audio/decode";
import { encodeWav } from "../audio/wav-encode";
import { exportZwt } from "../synth/zwt-export";
import { midiToNoteName } from "../analysis/yin";

export function assetFolder(type: AssetType): string | null {
  switch (type) {
    case "PercussiveOneShot":
    case "Impact":
      return "one_shots";
    case "MelodicOneShot":
    case "BassOneShot":
    case "WavetableCandidate":
      return "melodic";
    case "Wavetable":
      return "wavetables";
    case "DroneLoop":
    case "NoiseTexture":
    case "AmbienceLoop":
      return "drones";
    case "MelodicPhrase":
    case "VocalChop":
    case "SliceLoop":
      return "phrases";
    case "Reject":
      return null;
  }
}

export function sanitizeName(name: string): string {
  return name.replace(/[^\w\-]+/g, "_").replace(/^_+|_+$/g, "") || "asset";
}

type ExportInput = {
  projectName: string;
  sourceName: string | null;
  decoded: DecodedAudio | null;
  assets: AssetItem[];
  wavetables: WavetableItem[];
  drones: DroneLoopItem[];
  arrangement: ArrangementState;
};

function buildArrangement(arr: ArrangementState): Arrangement {
  const tracks: Arrangement["tracks"] = [];
  const stepBeats = 4 / STEPS_PER_BAR; // 16 step = 1/4 beat

  arr.drumLanes.forEach((lane, i) => {
    if (!lane.assetId) return;
    const events = [];
    for (let bar = 0; bar < arr.bars; bar++) {
      for (let s = 0; s < STEPS_PER_BAR; s++) {
        if (lane.steps[s]) {
          events.push({
            assetId: lane.assetId,
            startBeat: bar * 4 + s * stepBeats,
          });
        }
      }
    }
    tracks.push({ id: `drum_${i + 1}`, type: "drums", events });
  });

  if (arr.droneId) {
    tracks.push({
      id: "drone_1",
      type: "drone",
      events: [
        {
          assetId: arr.droneId,
          startBeat: 0,
          durationBeat: arr.bars * 4,
          gainDb: arr.droneGainDb,
        },
      ],
    });
  }

  if (arr.melodyLane.assetId) {
    const events = [];
    for (let bar = 0; bar < arr.bars; bar++) {
      for (let s = 0; s < STEPS_PER_BAR; s++) {
        const semi = arr.melodyLane.steps[s];
        if (semi !== null) {
          events.push({
            assetId: arr.melodyLane.assetId,
            startBeat: bar * 4 + s * stepBeats,
            pitchSemitone: semi,
          });
        }
      }
    }
    tracks.push({ id: "melody_1", type: "melody", events });
  }

  if (arr.phraseLane.assetId) {
    const events = [];
    for (let bar = 0; bar < arr.bars; bar++) {
      for (let s = 0; s < STEPS_PER_BAR; s++) {
        if (arr.phraseLane.steps[s]) {
          events.push({
            assetId: arr.phraseLane.assetId,
            startBeat: bar * 4 + s * stepBeats,
          });
        }
      }
    }
    tracks.push({ id: "phrase_1", type: "phrase", events });
  }

  return {
    id: "arr_001",
    name: "mini_loop",
    bpm: arr.bpm,
    bars: arr.bars,
    beatsPerBar: 4,
    tracks,
  };
}

export function buildManifest(input: ExportInput): ProjectManifest {
  const { decoded } = input;
  const sampleRate = decoded?.sampleRate ?? 48000;

  const segments: Segment[] = [];
  const assets: AudioAsset[] = [];

  for (const a of input.assets) {
    segments.push({
      id: a.segmentId,
      trackId: "track_001",
      startSec: a.startSample / sampleRate,
      endSec: a.endSample / sampleRate,
      startSample: a.startSample,
      endSample: a.endSample,
      detectionMethod: a.detectionMethod,
      confidence: a.confidence,
      features: {
        durationSec: a.features.durationSec,
        rmsDb: a.features.rmsDb,
        peakDb: a.features.peakDb,
        attackMs: a.features.attackMs,
        decayMs: a.features.decayMs,
        transientDensity: a.features.transientDensity,
        spectralCentroidMean: a.features.spectralCentroid,
        spectralFlatnessMean: a.features.spectralFlatness,
        zeroCrossingRateMean: a.features.zeroCrossingRate,
        presenceRatio: a.features.presenceRatio,
        crestDb: a.features.crestDb,
        spectralFluxMean: a.features.spectralFluxMean,
        f0MedianHz: a.features.pitchHz,
        f0Confidence: a.features.pitchConfidence,
        f0StabilityCents: a.features.pitchStabilityCents,
        voicedRatio: a.features.voicedRatio,
        pitchRangeSemitones: a.features.pitchRangeSemitones,
      },
    });

    const folder = assetFolder(a.type);
    assets.push({
      id: a.id,
      segmentId: a.segmentId,
      type: a.type,
      tags: [],
      renderedPath: folder ? `${folder}/${sanitizeName(a.name)}.wav` : undefined,
      rootMidi: a.rootMidi,
      rootNote: a.rootMidi !== undefined ? midiToNoteName(a.rootMidi) : undefined,
      pitchHz: a.features.pitchHz,
      confidence: a.confidence,
      uncertain: a.confidence < 0.6,
      userEdited: a.userEdited || undefined,
    });
  }

  // wavetable assets
  input.wavetables.forEach((wt, i) => {
    const segId = `seg_wt_${String(i + 1).padStart(3, "0")}`;
    segments.push({
      id: segId,
      trackId: "track_001",
      startSec: wt.generatedFrom.startSec,
      endSec: wt.generatedFrom.endSec,
      detectionMethod: "manual",
      confidence: wt.quality.pitchConfidence,
      features: {
        durationSec: wt.generatedFrom.endSec - wt.generatedFrom.startSec,
        rmsDb: 0,
        peakDb: 0,
        f0MedianHz: wt.sourcePitchHz,
        f0Confidence: wt.quality.pitchConfidence,
        f0StabilityCents: wt.quality.pitchStabilityCents,
      },
    });
    assets.push({
      id: wt.id,
      segmentId: segId,
      type: "Wavetable",
      tags: [],
      renderedPath: `wavetables/${sanitizeName(wt.name)}.wav`,
      rootMidi: wt.rootNote,
      rootNote: midiToNoteName(wt.rootNote),
      pitchHz: wt.sourcePitchHz,
      wavetable: {
        path: `wavetables/${sanitizeName(wt.name)}.zwt.json`,
        frameLen: 2048,
        frames: wt.frames,
        sampleFormat: "f32le",
        rootMidi: wt.rootNote,
        rootNote: midiToNoteName(wt.rootNote),
        sourcePitchHz: wt.sourcePitchHz,
        generatedFrom: {
          segmentId: wt.sourceAssetId ?? segId,
          startSec: wt.generatedFrom.startSec,
          endSec: wt.generatedFrom.endSec,
          method: "manual_region",
        },
        quality: wt.quality,
      },
      confidence: wt.quality.pitchConfidence,
    });
  });

  // drone loop assets
  input.drones.forEach((d, i) => {
    const segId = `seg_drone_${String(i + 1).padStart(3, "0")}`;
    segments.push({
      id: segId,
      trackId: "track_001",
      startSec: d.loop.startSample / sampleRate,
      endSec: d.loop.endSample / sampleRate,
      detectionMethod: "loop_candidate",
      confidence: 1 - Math.min(1, d.loop.score),
      features: {
        durationSec: (d.loop.endSample - d.loop.startSample) / sampleRate,
        rmsDb: 0,
        peakDb: 0,
      },
    });
    assets.push({
      id: d.id,
      segmentId: segId,
      type: "DroneLoop",
      tags: [],
      renderedPath: `drones/${sanitizeName(d.name)}.wav`,
      loop: {
        enabled: true,
        startSec: d.loop.startSample / sampleRate,
        endSec: d.loop.endSample / sampleRate,
        startSample: d.loop.startSample,
        endSample: d.loop.endSample,
        crossfadeMs: d.loop.crossfadeMs,
        score: d.loop.score,
        method: "auto_spectral",
      },
      confidence: 1 - Math.min(1, d.loop.score),
    });
  });

  return {
    version: "0.1",
    projectId: `project_${Date.now().toString(36)}`,
    name: input.projectName,
    createdAt: new Date().toISOString(),
    sources: decoded
      ? [
          {
            id: "src_001",
            originalName: input.sourceName ?? "unknown",
            durationSec: decoded.durationSec,
            sampleRate: decoded.sampleRate,
            channels: decoded.channels.length,
          },
        ]
      : [],
    derivedTracks: decoded
      ? [{ id: "track_001", sourceId: "src_001", kind: "Original" }]
      : [],
    segments,
    assets,
    arrangements: [buildArrangement(input.arrangement)],
  };
}

/** project 一式を zip にまとめる。 */
export function exportProjectZip(input: ExportInput): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const manifest = buildManifest(input);
  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));

  const { decoded } = input;
  if (decoded) {
    const usedNames = new Set<string>();
    const uniqueName = (base: string): string => {
      let name = base;
      let n = 2;
      while (usedNames.has(name)) name = `${base}_${n++}`;
      usedNames.add(name);
      return name;
    };

    for (const a of input.assets) {
      const folder = assetFolder(a.type);
      if (!folder) continue;
      const name = uniqueName(sanitizeName(a.name));
      const chans = decoded.channels.map((ch) =>
        ch.subarray(a.startSample, a.endSample)
      );
      files[`${folder}/${name}.wav`] = encodeWav(
        chans as Float32Array[],
        decoded.sampleRate,
        16
      );
    }

    for (const wt of input.wavetables) {
      const name = uniqueName(sanitizeName(wt.name));
      const zwt = exportZwt({ ...wt, name }, wt.sourceAssetId);
      files[`wavetables/${zwt.jsonName}`] = zwt.jsonBytes;
      files[`wavetables/${zwt.binName}`] = zwt.binBytes;
      // frame 列をつないだ確認用 wav も出す
      files[`wavetables/${name}.wav`] = encodeWav(
        [wt.samples],
        48000,
        32
      );
    }

    for (const d of input.drones) {
      const name = uniqueName(sanitizeName(d.name));
      files[`drones/${name}.wav`] = encodeWav([d.buffer], d.sampleRate, 16);
    }
  }

  return zipSync(files, { level: 6 });
}

export function downloadBytes(
  bytes: Uint8Array,
  filename: string,
  mime = "application/octet-stream"
): void {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const blob = new Blob([ab], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
