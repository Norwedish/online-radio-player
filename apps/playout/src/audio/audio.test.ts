import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbToGain, gainToDb, measure, int16ToFloat } from "@radio/core";
import { Deck } from "./deck.js";
import { LiveBus } from "./live-bus.js";
import { Mixer } from "./mixer.js";
import { WavStripper, streamingWavHeader } from "./wav.js";
import { sleep, tone } from "../test-utils.js";

let dir: string;
let long: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "radio-deck-"));
  long = tone(dir, "long", 30, 440, 0.5);
});
// Retries: on Windows an FFmpeg process that is still exiting can briefly lock the files.
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

/** Pulls `seconds` of audio from a deck in 10 ms blocks, yielding so FFmpeg can fill the buffer. */
async function pull(deck: Deck, seconds: number, out?: Float32Array[]): Promise<void> {
  const blocks = Math.round(seconds * 100);
  for (let b = 0; b < blocks; b += 1) {
    while (!deck.ready && deck.state !== "ended") await sleep(2);
    const buf = new Float32Array(960);
    deck.mixInto(buf, 480, 1);
    out?.push(buf);
    if (b % 50 === 0) await sleep(0);
  }
}

describe("Deck (M4.2)", () => {
  it("plays, pauses at 10 s and resumes with position accurate to ±50 ms", async () => {
    const deck = new Deck({ path: long, cueIn: 0, duration: 30, fadeIn: 0, fadeOut: 0, gainDb: 0 });
    deck.load(0);
    deck.play();
    await pull(deck, 10);
    expect(Math.abs(deck.position - 10)).toBeLessThanOrEqual(0.05);
    deck.pause();
    expect(deck.state).toBe("paused");
    await sleep(100);
    expect(Math.abs(deck.position - 10)).toBeLessThanOrEqual(0.05);
    deck.resume();
    await pull(deck, 2);
    expect(Math.abs(deck.position - 12)).toBeLessThanOrEqual(0.05);
    deck.seek(25);
    await pull(deck, 1);
    expect(Math.abs(deck.position - 26)).toBeLessThanOrEqual(0.05);
    deck.stop();
  });

  it("applies cue-in/out, loudness gain and emits ended", async () => {
    const deck = new Deck({ path: long, cueIn: 5, duration: 2, fadeIn: 0, fadeOut: 0, gainDb: -6 });
    let ended = false;
    deck.on("ended", () => (ended = true));
    deck.load(0);
    deck.play();
    const out: Float32Array[] = [];
    await pull(deck, 2.3, out);
    expect(ended).toBe(true);
    expect(deck.position).toBeCloseTo(2, 1);
    const mid = measure(out[100]!);
    expect(mid.peak).toBeCloseTo(gainToDb(0.5 * dbToGain(-6)), 0);
  });

  it("fades in from silence", async () => {
    const deck = new Deck({ path: long, cueIn: 0, duration: 5, fadeIn: 1, fadeOut: 0, gainDb: 0 });
    deck.load(0);
    deck.play();
    const out: Float32Array[] = [];
    await pull(deck, 1.5, out);
    expect(measure(out[0]!).peak).toBeLessThan(-30);
    expect(measure(out[120]!).peak).toBeCloseTo(gainToDb(0.5), 0);
    deck.stop();
  });

  it("reports an error for a missing file", async () => {
    const deck = new Deck({
      path: join(dir, "missing.mp3"),
      cueIn: 0,
      duration: 5,
      fadeIn: 0,
      fadeOut: 0,
      gainDb: 0,
    });
    const err = new Promise<Error>((resolve) => deck.on("error", resolve));
    deck.load(0);
    expect((await err).message).toMatch(/ffmpeg exited/);
  });
});

describe("Mixer (M4.3)", () => {
  it("mixes two tones at -6 dB each without clipping", async () => {
    const a = tone(dir, "a", 3, 440, 0.5);
    const b = tone(dir, "b", 3, 660, 0.5);
    const mixer = new Mixer(new LiveBus(), { duckDb: -12, duckAttackMs: 50, duckReleaseMs: 500 });
    for (const p of [a, b]) {
      const d = new Deck({ path: p, cueIn: 0, duration: 3, fadeIn: 0, fadeOut: 0, gainDb: 0 });
      d.load(0);
      d.play();
      mixer.decks.automation.add(d);
    }
    await sleep(150);
    let maxPeak = -120;
    for (let i = 0; i < 200; i += 1) {
      const pcm = mixer.render(480);
      maxPeak = Math.max(maxPeak, measure(int16ToFloat(pcm)).peak);
    }
    expect(maxPeak).toBeLessThanOrEqual(-0.9);
    expect(maxPeak).toBeGreaterThan(-3);
  });

  it("ducks automation by the configured depth while live is active", async () => {
    const live = new LiveBus(20);
    const mixer = new Mixer(live, { duckDb: -12, duckAttackMs: 20, duckReleaseMs: 200 });
    const d = new Deck({ path: long, cueIn: 0, duration: 30, fadeIn: 0, fadeOut: 0, gainDb: 0 });
    d.load(0);
    d.play();
    mixer.decks.automation.add(d);
    await sleep(150);
    mixer.render(4800);
    mixer.readMeters();
    mixer.duckRequested = true;
    live.active = true;
    for (let i = 0; i < 50; i += 1) mixer.render(480);
    expect(gainToDb(mixer.duckGain)).toBeCloseTo(-12, 0);
    const meters = mixer.readMeters();
    expect(meters.duckGain).toBeCloseTo(-12, 0);
    mixer.duckRequested = false;
    for (let i = 0; i < 200; i += 1) mixer.render(480);
    expect(mixer.duckGain).toBeGreaterThan(0.99);
    d.stop();
  });

  it("live bus jitter buffer holds audio until the target is reached", () => {
    const live = new LiveBus(100);
    live.active = true;
    const out = new Float32Array(960);
    live.push(Buffer.alloc(48 * 50 * 2, 0x10), 1); // 50 ms mono
    live.mixInto(out, 480, 1);
    expect(out.every((v) => v === 0)).toBe(true);
    live.push(Buffer.alloc(48 * 80 * 2, 0x10), 1);
    live.mixInto(out, 480, 1);
    expect(out.some((v) => v !== 0)).toBe(true);
  });
});

describe("WAV framing", () => {
  it("strips a streaming header split across chunks", () => {
    const s = new WavStripper();
    const h = streamingWavHeader();
    const payload = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const all = Buffer.concat([h, payload]);
    const out = Buffer.concat([
      s.push(all.subarray(0, 10)),
      s.push(all.subarray(10, 30)),
      s.push(all.subarray(30)),
    ]);
    expect([...out]).toEqual([...payload]);
    const raw = new WavStripper();
    expect([...raw.push(Buffer.from("not a wav file at all"))].length).toBe(21);
  });
});
