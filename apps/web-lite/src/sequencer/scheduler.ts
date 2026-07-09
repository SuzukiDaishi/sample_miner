/**
 * Mini Loop Builder の再生スケジューラ。
 * Web Audio の lookahead 方式で 4〜8 小節ループを再生する。
 */
import { getAudioContext } from "../audio/decode";
import type { DecodedAudio } from "../audio/decode";
import type {
  ArrangementState,
  AssetItem,
  DroneLoopItem,
} from "../state/store";
import { STEPS_PER_BAR } from "../state/store";

export type OneShotEvent = {
  laneType: "drums" | "melody" | "phrase";
  laneIndex: number;
  assetId: string;
  timeSec: number; // loop 先頭からの相対時間
  playbackRate: number;
  gainDb: number;
};

export type LoopPlan = {
  events: OneShotEvent[];
  drone: { droneId: string; gainDb: number } | null;
  loopDurationSec: number;
};

export function buildLoopPlan(arr: ArrangementState): LoopPlan {
  const secondsPerBeat = 60 / arr.bpm;
  const stepSec = secondsPerBeat / (STEPS_PER_BAR / 4);
  const loopDurationSec = arr.bars * 4 * secondsPerBeat;

  const events: OneShotEvent[] = [];

  for (let bar = 0; bar < arr.bars; bar++) {
    const barStart = bar * 4 * secondsPerBeat;

    arr.drumLanes.forEach((lane, li) => {
      if (!lane.assetId) return;
      for (let s = 0; s < STEPS_PER_BAR; s++) {
        if (lane.steps[s]) {
          events.push({
            laneType: "drums",
            laneIndex: li,
            assetId: lane.assetId,
            timeSec: barStart + s * stepSec,
            playbackRate: 1,
            gainDb: 0,
          });
        }
      }
    });

    if (arr.melodyLane.assetId) {
      for (let s = 0; s < STEPS_PER_BAR; s++) {
        const semi = arr.melodyLane.steps[s];
        if (semi !== null) {
          events.push({
            laneType: "melody",
            laneIndex: 0,
            assetId: arr.melodyLane.assetId,
            timeSec: barStart + s * stepSec,
            playbackRate: Math.pow(2, semi / 12),
            gainDb: -3,
          });
        }
      }
    }

    if (arr.phraseLane.assetId) {
      for (let s = 0; s < STEPS_PER_BAR; s++) {
        if (arr.phraseLane.steps[s]) {
          events.push({
            laneType: "phrase",
            laneIndex: 0,
            assetId: arr.phraseLane.assetId,
            timeSec: barStart + s * stepSec,
            playbackRate: 1,
            gainDb: -3,
          });
        }
      }
    }
  }

  return {
    events,
    drone: arr.droneId
      ? { droneId: arr.droneId, gainDb: arr.droneGainDb }
      : null,
    loopDurationSec,
  };
}

export function makeAssetBuffer(
  ctx: BaseAudioContext,
  decoded: DecodedAudio,
  asset: AssetItem
): AudioBuffer {
  const len = Math.max(1, asset.endSample - asset.startSample);
  const buf = ctx.createBuffer(
    decoded.channels.length,
    len,
    decoded.sampleRate
  );
  for (let ch = 0; ch < decoded.channels.length; ch++) {
    buf.copyToChannel(
      decoded.channels[ch].subarray(
        asset.startSample,
        asset.endSample
      ) as Float32Array<ArrayBuffer>,
      ch
    );
  }
  return buf;
}

export function makeDroneBuffer(
  ctx: BaseAudioContext,
  drone: DroneLoopItem
): AudioBuffer {
  const buf = ctx.createBuffer(1, drone.buffer.length, drone.sampleRate);
  buf.copyToChannel(drone.buffer as Float32Array<ArrayBuffer>, 0);
  return buf;
}

/** loop 1 周分のイベントを destination へスケジュールする。 */
export function scheduleIteration(
  ctx: BaseAudioContext,
  destination: AudioNode,
  plan: LoopPlan,
  startTime: number,
  assetBuffers: Map<string, AudioBuffer>,
  droneBuffer: AudioBuffer | null,
  laneFilter?: (e: OneShotEvent) => boolean
): AudioScheduledSourceNode[] {
  const started: AudioScheduledSourceNode[] = [];

  for (const e of plan.events) {
    if (laneFilter && !laneFilter(e)) continue;
    const buf = assetBuffers.get(e.assetId);
    if (!buf) continue;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = e.playbackRate;
    const gain = ctx.createGain();
    gain.gain.value = Math.pow(10, e.gainDb / 20);
    src.connect(gain).connect(destination);
    src.start(startTime + e.timeSec);
    started.push(src);
  }

  return started;
}

export class LoopPlayer {
  private timer: number | null = null;
  private startedSources: AudioScheduledSourceNode[] = [];
  private droneSource: AudioBufferSourceNode | null = null;
  private nextIterationTime = 0;
  playing = false;
  /** 再生中の step 表示用 */
  getPositionSec: () => number = () => 0;

  start(
    plan: LoopPlan,
    assetBuffers: Map<string, AudioBuffer>,
    droneBuffer: AudioBuffer | null
  ): void {
    this.stop();
    const ctx = getAudioContext();
    void ctx.resume();

    const startAt = ctx.currentTime + 0.1;
    this.nextIterationTime = startAt;
    this.playing = true;
    this.getPositionSec = () =>
      (ctx.currentTime - startAt + plan.loopDurationSec * 1000) %
      plan.loopDurationSec;

    if (plan.drone && droneBuffer) {
      const src = ctx.createBufferSource();
      src.buffer = droneBuffer;
      src.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = Math.pow(10, plan.drone.gainDb / 20);
      src.connect(gain).connect(ctx.destination);
      src.start(startAt);
      this.droneSource = src;
    }

    const scheduleAhead = () => {
      // 次の 1 周が 0.3 秒以内に迫っていたらスケジュール
      while (this.nextIterationTime < ctx.currentTime + 0.3) {
        const started = scheduleIteration(
          ctx,
          ctx.destination,
          plan,
          this.nextIterationTime,
          assetBuffers,
          null
        );
        this.startedSources.push(...started);
        this.nextIterationTime += plan.loopDurationSec;
        // 終了済み source の参照を掃除
        this.startedSources = this.startedSources.slice(-256);
      }
    };

    scheduleAhead();
    this.timer = window.setInterval(scheduleAhead, 100);
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    for (const s of this.startedSources) {
      try {
        s.stop();
      } catch {
        // not started yet / already stopped
      }
    }
    this.startedSources = [];
    if (this.droneSource) {
      try {
        this.droneSource.stop();
      } catch {
        // ignore
      }
      this.droneSource = null;
    }
    this.playing = false;
  }
}

export const loopPlayer = new LoopPlayer();
