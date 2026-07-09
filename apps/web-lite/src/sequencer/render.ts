/**
 * Mini Loop Builder の offline render。
 * OfflineAudioContext で mix と track 別 stems を書き出す。
 */
import type { DecodedAudio } from "../audio/decode";
import type {
  ArrangementState,
  AssetItem,
  DroneLoopItem,
} from "../state/store";
import {
  buildLoopPlan,
  makeAssetBuffer,
  makeDroneBuffer,
  scheduleIteration,
  type OneShotEvent,
} from "./scheduler";

export type RenderedArrangement = {
  mix: { channels: Float32Array[]; sampleRate: number };
  stems: { name: string; channels: Float32Array[]; sampleRate: number }[];
};

type StemDef = {
  name: string;
  filter?: (e: OneShotEvent) => boolean;
  includeDrone: boolean;
  includeEvents: boolean;
};

async function renderOne(
  arr: ArrangementState,
  decoded: DecodedAudio,
  assets: AssetItem[],
  drones: DroneLoopItem[],
  def: StemDef
): Promise<{ channels: Float32Array[]; sampleRate: number }> {
  const plan = buildLoopPlan(arr);
  const sampleRate = decoded.sampleRate;
  const tailSec = 2;
  const length = Math.ceil((plan.loopDurationSec + tailSec) * sampleRate);
  const ctx = new OfflineAudioContext(2, length, sampleRate);

  const assetsById = new Map(assets.map((a) => [a.id, a]));
  const assetBuffers = new Map<string, AudioBuffer>();
  for (const e of plan.events) {
    if (!assetBuffers.has(e.assetId)) {
      const a = assetsById.get(e.assetId);
      if (a) assetBuffers.set(e.assetId, makeAssetBuffer(ctx, decoded, a));
    }
  }

  if (def.includeEvents) {
    scheduleIteration(
      ctx,
      ctx.destination,
      plan,
      0,
      assetBuffers,
      null,
      def.filter
    );
  }

  if (def.includeDrone && plan.drone) {
    const drone = drones.find((d) => d.id === plan.drone!.droneId);
    if (drone) {
      const src = ctx.createBufferSource();
      src.buffer = makeDroneBuffer(ctx, drone);
      src.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = Math.pow(10, plan.drone.gainDb / 20);
      src.connect(gain).connect(ctx.destination);
      src.start(0);
      src.stop(plan.loopDurationSec);
    }
  }

  const rendered = await ctx.startRendering();
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
    channels.push(rendered.getChannelData(ch).slice());
  }
  return { channels, sampleRate };
}

export async function renderArrangement(
  arr: ArrangementState,
  decoded: DecodedAudio,
  assets: AssetItem[],
  drones: DroneLoopItem[]
): Promise<RenderedArrangement> {
  const mix = await renderOne(arr, decoded, assets, drones, {
    name: "mix",
    includeDrone: true,
    includeEvents: true,
  });

  const stems: RenderedArrangement["stems"] = [];
  const defs: StemDef[] = [
    {
      name: "drums",
      filter: (e) => e.laneType === "drums",
      includeDrone: false,
      includeEvents: true,
    },
    { name: "drone", includeDrone: true, includeEvents: false },
    {
      name: "melody",
      filter: (e) => e.laneType === "melody",
      includeDrone: false,
      includeEvents: true,
    },
    {
      name: "phrase",
      filter: (e) => e.laneType === "phrase",
      includeDrone: false,
      includeEvents: true,
    },
  ];

  for (const def of defs) {
    const r = await renderOne(arr, decoded, assets, drones, def);
    // 完全無音の stem はスキップ
    const hasSignal = r.channels.some((ch) => {
      for (let i = 0; i < ch.length; i += 64) {
        if (Math.abs(ch[i]) > 1e-6) return true;
      }
      return false;
    });
    if (hasSignal) stems.push({ name: def.name, ...r });
  }

  return { mix, stems };
}
