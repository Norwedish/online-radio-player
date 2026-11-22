/**
 * Mixer (PLAN §6.4.3 / M4.3): automation deck(s), voice-over, live, event and
 * emergency buses → ducking envelope → master fader → look-ahead limiter →
 * one s16le stream. Meters are accumulated per bus and read at 10 Hz.
 */
import {
  BYTES_PER_FRAME,
  Envelope,
  Limiter,
  Meter,
  dbToGain,
  floatToInt16,
  gainToDb,
  measure,
} from "@radio/core";
import type { MeterFrame } from "@radio/shared";
import type { Deck } from "./deck.js";
import type { LiveBus } from "./live-bus.js";

export type BusName = "automation" | "voiceover" | "live" | "event" | "emergency";

export interface MixerOptions {
  duckDb: number;
  duckAttackMs: number;
  duckReleaseMs: number;
  limiterThresholdDb?: number;
  masterGain?: number;
}

export class Mixer {
  /** Decks currently audible on each bus (more than one during a boundary cut fade). */
  readonly decks: Record<Exclude<BusName, "live">, Set<Deck>> = {
    automation: new Set(),
    voiceover: new Set(),
    event: new Set(),
    emergency: new Set(),
  };
  readonly busGain: Record<BusName, number> = {
    automation: 1,
    voiceover: 1,
    live: 1,
    event: 1,
    emergency: 1,
  };
  readonly busMute: Record<BusName, boolean> = {
    automation: false,
    voiceover: false,
    live: false,
    event: false,
    emergency: false,
  };
  private readonly duck: Envelope;
  private readonly limiter: Limiter;
  private readonly meters: Record<BusName | "master", Meter> = {
    automation: new Meter(),
    voiceover: new Meter(),
    live: new Meter(),
    event: new Meter(),
    emergency: new Meter(),
    master: new Meter(),
  };
  private scratch = new Float32Array(0);
  private busScratch = new Float32Array(0);
  fader = 1;
  duckDb: number;
  /** Live in duck mode or a voice-over is active → automation ducks. */
  duckRequested = false;
  /** Last block's master RMS (dBFS) before limiting — used by the silence detector. */
  lastRmsDb = -120;
  framesMixed = 0;

  constructor(
    readonly live: LiveBus,
    options: MixerOptions,
  ) {
    this.duckDb = options.duckDb;
    this.duck = new Envelope(1, options.duckAttackMs, options.duckReleaseMs);
    this.limiter = new Limiter(options.limiterThresholdDb ?? -1, 5, 80);
    this.fader = options.masterGain ?? 1;
  }

  setDuckTiming(attackMs: number, releaseMs: number): void {
    this.duck.attackMs = attackMs;
    this.duck.releaseMs = releaseMs;
  }

  get duckGain(): number {
    return this.duck.current;
  }

  private mixBus(bus: Exclude<BusName, "live">, frames: number, gain: number): void {
    const decks = this.decks[bus];
    if (decks.size === 0 || this.busMute[bus]) return;
    const b = this.busScratch;
    b.fill(0, 0, frames * 2);
    for (const deck of decks) deck.mixInto(b, frames, 1);
    this.meters[bus].add(b, frames * 2, gain);
    for (let i = 0; i < frames * 2; i += 1) this.scratch[i] = this.scratch[i]! + b[i]! * gain;
  }

  /** Produces `frames` frames of final PCM. */
  render(frames: number): Buffer {
    const n = frames * 2;
    if (this.scratch.length < n) {
      this.scratch = new Float32Array(n);
      this.busScratch = new Float32Array(n);
    }
    this.scratch.fill(0, 0, n);
    const duckTarget = this.duckRequested ? dbToGain(this.duckDb) : 1;
    const duck = this.duck.step(duckTarget, frames);
    this.mixBus("automation", frames, this.busGain.automation * duck);
    this.mixBus("event", frames, this.busGain.event * duck);
    this.mixBus("voiceover", frames, this.busGain.voiceover);
    this.mixBus("emergency", frames, this.busGain.emergency);
    if (!this.busMute.live && this.live.active) {
      const b = this.busScratch;
      b.fill(0, 0, n);
      this.live.mixInto(b, frames, 1);
      this.meters.live.add(b, n, this.busGain.live);
      for (let i = 0; i < n; i += 1) this.scratch[i] = this.scratch[i]! + b[i]! * this.busGain.live;
    }
    if (this.fader !== 1)
      for (let i = 0; i < n; i += 1) this.scratch[i] = this.scratch[i]! * this.fader;
    this.lastRmsDb = measure(this.scratch, n).rms;
    this.limiter.process(this.scratch, n);
    this.meters.master.add(this.scratch, n);
    this.framesMixed += frames;
    return floatToInt16(this.scratch, n);
  }

  readMeters(): MeterFrame {
    const master = this.meters.master.read();
    const buses = (Object.keys(this.busGain) as BusName[]).map((name) => {
      const m = this.meters[name].read();
      return {
        name,
        peak: round(m.peak),
        rms: round(m.rms),
        gain: round(gainToDb(this.busGain[name])),
      };
    });
    return {
      masterPeak: round(master.peak),
      masterRms: round(master.rms),
      buses,
      duckGain: round(gainToDb(this.duck.current)),
    };
  }

  get limiterReductionDb(): number {
    return this.limiter.reductionDb;
  }

  static bytes(frames: number): number {
    return frames * BYTES_PER_FRAME;
  }
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}
