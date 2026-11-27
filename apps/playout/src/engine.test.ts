import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeEnvelope, gainToDb } from "@radio/core";
import type { MediaRow } from "@radio/db";
import { LiveBus } from "./audio/live-bus.js";
import { Mixer } from "./audio/mixer.js";
import { PlayoutEngine } from "./engine.js";
import { FakePlanSource, item, tone } from "./test-utils.js";

let dir: string;
const files: Record<string, string> = {};
// Hour 10 of 2030-01-01 (UTC) — the boundary B is 11:00:00.
const HOUR = Date.UTC(2030, 0, 1, 10);
const B = HOUR + 3_600_000;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "radio-engine-"));
  for (const [name, secs, freq, amp] of [
    ["s2", 2, 300, 0.3],
    ["s4", 4, 350, 0.3],
    ["s6", 6, 400, 0.3],
    ["s13", 13, 450, 0.3],
    ["s20", 20, 500, 0.3],
    ["news", 3, 800, 0.3],
    ["silent", 6, 400, 0],
    ["jingle", 2, 900, 0.3],
  ] as const) {
    files[name] = tone(dir, name, secs, freq, amp);
  }
});
// Retries: on Windows an FFmpeg process that is still exiting can briefly lock the files.
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

function setup(opts: { startOffset: number; tolerance?: number; silenceSeconds?: number }) {
  const source = new FakePlanSource("UTC");
  const live = new LiveBus(20);
  const mixer = new Mixer(live, { duckDb: -12, duckAttackMs: 20, duckReleaseMs: 200 });
  const t0 = B - opts.startOffset * 1000;
  const now = () => t0 + mixer.framesMixed / 48;
  const alerts: string[] = [];
  const engine = new PlayoutEngine({
    source,
    mixer,
    now,
    toleranceSeconds: opts.tolerance ?? 5,
    silenceThresholdDb: -60,
    silenceSeconds: opts.silenceSeconds ?? 10,
    emergencyFile: join(dir, "nope.mp3"),
    autoTick: false,
    autoRecoverSeconds: 0,
    alert: (a) => alerts.push(a.type),
  });
  const started: string[] = [];
  const ended: { title: string; reason: string }[] = [];
  engine.on(
    "worker-event",
    (type: string, payload: { item?: { title: string }; reason?: string }) => {
      if (type === "track_started") started.push(payload.item!.title);
      if (type === "track_ended")
        ended.push({ title: payload.item!.title, reason: payload.reason ?? "" });
    },
  );
  /** Runs the clock for `seconds` of audio, ticking the scheduler every 100 ms. */
  const run = async (seconds: number) => {
    const blocks = Math.round(seconds * 100);
    for (let i = 0; i < blocks; i += 1) {
      // Fast-forward harness: let every audible deck buffer before rendering (real time never outruns FFmpeg).
      const starving = () =>
        Object.values(mixer.decks).some((set) =>
          [...set].some((d) => (d.state === "playing" || d.state === "loading") && !d.ready),
        );
      for (let w = 0; w < 200 && starving(); w += 1) await new Promise((r) => setTimeout(r, 2));
      mixer.render(480);
      engine.onRendered(mixer.lastRmsDb, 480);
      if (i % 10 === 0) engine.tick();
      if (i % 20 === 0) await new Promise((r) => setImmediate(r));
    }
  };
  const hourKey = (ms: number) => {
    const d = new Date(ms);
    return `${d.toISOString().slice(0, 10)}:${d.getUTCHours()}`;
  };
  return { source, mixer, engine, now, run, started, ended, alerts, t0, hourKey };
}

const news = (title = "News 11") =>
  item(files.news!, 3, { kind: "news", title, locked: true, plannedStart: B });

describe("PlayoutEngine boundary rules (M4.4/M4.5)", () => {
  it("rule 2: track ends 4 s before B → news starts early and is logged", async () => {
    const t = setup({ startOffset: 10 });
    t.source.hours.set(t.hourKey(B - 1), [item(files.s6!, 6, { title: "A", plannedStart: t.t0 })]);
    t.source.hours.set(t.hourKey(B), [
      news(),
      item(files.s4!, 4, { title: "C", plannedStart: B + 3000 }),
    ]);
    t.engine.start();
    await t.run(9);
    expect(t.started.slice(0, 2)).toEqual(["A", "News 11"]);
    const log = t.engine.boundaryLog[0]!;
    expect(log.action).toBe("early_news");
    expect(log.deviationMs).toBeGreaterThan(-4300);
    expect(log.deviationMs).toBeLessThan(-3700);
    t.engine.shutdown();
  });

  it("rule 3: overrun beyond tolerance → cut at B with a short fade", async () => {
    const t = setup({ startOffset: 10 });
    t.source.hours.set(t.hourKey(B - 1), [
      item(files.s20!, 20, { title: "Long", plannedStart: t.t0 }),
    ]);
    t.source.hours.set(t.hourKey(B), [news()]);
    t.engine.start();
    await t.run(11);
    expect(t.started).toEqual(["Long", "News 11"]);
    const log = t.engine.boundaryLog[0]!;
    expect(log.action).toBe("cut");
    expect(Math.abs(log.deviationMs)).toBeLessThan(150);
    t.engine.shutdown();
  });

  it("rule 3: overrun within tolerance → let it finish, news starts late", async () => {
    const t = setup({ startOffset: 10 });
    t.source.hours.set(t.hourKey(B - 1), [
      item(files.s13!, 13, { title: "Medium", plannedStart: t.t0 }),
    ]);
    t.source.hours.set(t.hourKey(B), [news()]);
    t.engine.start();
    await t.run(14);
    expect(t.started).toEqual(["Medium", "News 11"]);
    const log = t.engine.boundaryLog[0]!;
    expect(log.action).toBe("late_news");
    expect(log.deviationMs).toBeGreaterThan(2800);
    expect(log.deviationMs).toBeLessThan(3300);
    t.engine.shutdown();
  });

  it("rule 4: no new music with less than tol before B → stale music skipped, news early", async () => {
    const t = setup({ startOffset: 10 });
    t.source.hours.set(t.hourKey(B - 1), [
      item(files.s6!, 6, { title: "A", plannedStart: t.t0 }),
      item(files.s4!, 4, { title: "Stale", plannedStart: t.t0 + 6000 }),
    ]);
    t.source.hours.set(t.hourKey(B), [news()]);
    t.engine.start();
    await t.run(8);
    expect(t.started).toEqual(["A", "News 11"]);
    expect(t.engine.boundaryLog[0]!.action).toBe("early_news");
    t.engine.shutdown();
  });

  it("fills a gap larger than the tolerance with a filler track", async () => {
    const t = setup({ startOffset: 10, tolerance: 3 });
    t.source.fillers = [item(files.jingle!, 2, { title: "Filler", kind: "jingle" })];
    t.source.hours.set(t.hourKey(B - 1), [
      item(files.s2!, 2, { title: "Short", plannedStart: t.t0 }),
    ]);
    t.source.hours.set(t.hourKey(B), [news()]);
    t.engine.start();
    await t.run(10);
    expect(t.started.slice(0, 2)).toEqual(["Short", "Filler"]);
    expect(t.started).toContain("News 11");
    t.engine.shutdown();
  });

  it("rule 7: a live session across B suppresses the forced news", async () => {
    const t = setup({ startOffset: 8 });
    t.source.hours.set(t.hourKey(B - 1), [
      item(files.s20!, 20, { title: "Bed", plannedStart: t.t0 }),
    ]);
    t.source.hours.set(t.hourKey(B), [news()]);
    t.engine.start();
    await t.run(0.5);
    t.engine.liveStart({ mode: "duck", source: "studio", userId: 1, sessionId: 1, record: false });
    await t.run(9);
    expect(t.started).toEqual(["Bed"]);
    expect(t.engine.boundaryLog[0]?.details.overridden).toBe(true);
    t.engine.shutdown();
  });
});

describe("PlayoutEngine controls (M4.4)", () => {
  it("skip, pause/resume and play-now (interrupted track resumes)", async () => {
    const t = setup({ startOffset: 120 });
    t.source.hours.set(t.hourKey(B - 1), [
      item(files.s20!, 20, { title: "One", plannedStart: t.t0 }),
      item(files.s20!, 20, { title: "Two", plannedStart: t.t0 + 20_000 }),
      item(files.s20!, 20, { title: "Three", plannedStart: t.t0 + 40_000 }),
    ]);
    t.engine.start();
    await t.run(1);
    t.engine.skip();
    await t.run(0.5);
    expect(t.started).toEqual(["One", "Two"]);
    t.engine.pause();
    const pos = t.engine.current!.deck.position;
    await t.run(1);
    expect(t.engine.current!.deck.position).toBeCloseTo(pos, 1);
    t.engine.resume();
    await t.run(2);
    expect(t.engine.current!.deck.position).toBeGreaterThan(pos + 1.5);
    t.engine.playNow(item(files.jingle!, 2, { title: "Stinger", kind: "stinger" }));
    expect(t.engine.mode).toBe("interrupt");
    await t.run(2.5);
    expect(t.started.slice(-2)).toEqual(["Stinger", "Two"]);
    expect(t.engine.mode).toBe("autoplay");
    t.engine.shutdown();
  });

  it("queue move/remove guard locked items", async () => {
    const t = setup({ startOffset: 30 });
    t.source.hours.set(t.hourKey(B - 1), [
      item(files.s20!, 20, { title: "X", plannedStart: t.t0 }),
      item(files.s4!, 4, { title: "Y", plannedStart: t.t0 + 20_000 }),
    ]);
    t.source.hours.set(t.hourKey(B), [news()]);
    t.engine.start();
    await t.run(0.2);
    const newsItem = t.engine.queue.find((q) => q.locked)!;
    expect(() => t.engine.queueRemove(newsItem.uid)).toThrow(/locked/);
    const y = t.engine.queue.find((q) => q.title === "Y")!;
    t.engine.queueMove(y.uid, 5);
    expect(t.engine.queue.at(-1)!.title).toBe("Y");
    t.engine.queueRemove(y.uid);
    expect(t.engine.queue.some((q) => q.title === "Y")).toBe(false);
    t.engine.shutdown();
  });

  it("voice-over ducks the automation bus and restores afterwards", async () => {
    const t = setup({ startOffset: 60 });
    t.source.hours.set(t.hourKey(B - 1), [
      item(files.s20!, 20, { title: "Bed", plannedStart: t.t0 }),
    ]);
    t.engine.start();
    await t.run(0.5);
    t.engine.voiceOverStart(item(files.s2!, 2, { title: "VO", kind: "voiceover" }));
    await t.run(1);
    expect(gainToDb(t.mixer.duckGain)).toBeCloseTo(-12, 0);
    await t.run(2.5);
    expect(t.engine.getState().voiceOver.active).toBe(false);
    expect(t.mixer.duckGain).toBeGreaterThan(0.95);
    t.engine.shutdown();
  });
});

describe("Emergency (M4.6)", () => {
  it("silence triggers emergency within the configured time and can be cleared", async () => {
    const t = setup({ startOffset: 60, silenceSeconds: 1 });
    t.source.hours.set(t.hourKey(B - 1), [
      item(files.silent!, 6, { title: "Dead", plannedStart: t.t0 }),
      item(files.s20!, 20, { title: "After", plannedStart: t.t0 + 6000 }),
    ]);
    t.engine.start();
    await t.run(1.6);
    expect(t.engine.emergency.active).toBe(true);
    expect(t.engine.mode).toBe("emergency");
    expect(t.alerts).toContain("dead_air");
    expect(t.alerts).toContain("emergency_file_missing");
    await t.run(0.5);
    expect(t.mixer.readMeters().masterPeak).toBeGreaterThan(-40); // generated emergency tone audible
    t.engine.clearEmergency();
    await t.run(0.5);
    expect(t.engine.emergency.active).toBe(false);
    expect(t.engine.mode).toBe("autoplay");
    t.engine.shutdown();
  });

  it("does not trigger emergency while intentionally paused", async () => {
    const t = setup({ startOffset: 60, silenceSeconds: 1 });
    t.source.hours.set(t.hourKey(B - 1), [
      item(files.s20!, 20, { title: "Bed", plannedStart: t.t0 }),
    ]);
    t.engine.start();
    await t.run(0.3);
    t.engine.pause();
    await t.run(2);
    expect(t.engine.emergency.active).toBe(false);
    t.engine.shutdown();
  });

  it("plays fallback music and alerts when the hour has no plan", async () => {
    const t = setup({ startOffset: 60 });
    t.source.fillers = [item(files.s4!, 4, { title: "Fallback" })];
    t.engine.start();
    await t.run(0.3);
    expect(t.started[0]).toBe("Fallback");
    expect(t.alerts).toContain("plan_missing");
    t.engine.shutdown();
  });

  it("live takeover pauses automation and resumes the track when ended before the boundary", async () => {
    const t = setup({ startOffset: 120 });
    t.source.hours.set(t.hourKey(B - 1), [
      item(files.s20!, 20, { title: "Song", plannedStart: t.t0 }),
    ]);
    t.engine.start();
    await t.run(2);
    t.engine.liveStart({
      mode: "takeover",
      source: "studio",
      userId: 1,
      sessionId: 1,
      record: false,
    });
    const pos = t.engine.current!.deck.position;
    await t.run(1);
    expect(t.engine.current!.deck.state).toBe("paused");
    t.engine.liveStop();
    await t.run(1);
    expect(t.engine.current!.item.title).toBe("Song");
    expect(t.engine.current!.deck.position).toBeGreaterThan(pos + 0.8);
    expect(t.engine.current!.deck.position).toBeLessThan(pos + 1.3);
    t.engine.shutdown();
  });
});

describe("news refresh", () => {
  it("plays the current news file length, not the one from when the hour was planned", async () => {
    const t = setup({ startOffset: 10 });
    t.source.hours.set(t.hourKey(B - 1), [item(files.s6!, 6, { title: "A", plannedStart: t.t0 })]);
    const planned = news();
    t.source.hours.set(t.hourKey(B), [planned]);
    // Meanwhile the bulletin was replaced by a 6 s version with new cue points.
    t.source.media = ((id: number) =>
      id === planned.mediaId
        ? ({
            id,
            path: files.s6!,
            title: "News 11",
            artist: null,
            duration: 6,
            cue_in: 0.2,
            cue_out: 5.9,
            fade_in: 0,
            fade_out: 0,
            gain_db: -2,
            intro_end: null,
            outro_start: null,
            artwork_path: null,
            status: "ok",
          } as unknown as MediaRow)
        : undefined) as typeof t.source.media;
    t.engine.start();
    await t.run(7);
    expect(t.started).toEqual(["A", "News 11"]);
    expect(t.engine.current!.item).toMatchObject({
      path: files.s6,
      cueIn: 0.2,
      duration: 5.7,
      gainDb: -2,
    });
    t.engine.shutdown();
  }, 30_000);
});

describe("crossfades (autocue)", () => {
  it("starts the next track at the detected fade point and overlaps both", async () => {
    const t = setup({ startOffset: 10 });
    t.source.hours.set(t.hourKey(B - 1), [
      item(files.s6!, 6, { title: "A", plannedStart: t.t0, fadeOut: 2 }),
      item(files.s4!, 4, { title: "B", plannedStart: t.t0 + 6000 }),
    ]);
    t.engine.start();
    await t.run(4.15);
    // A is 6 s long with a 2 s fade-out → B starts at 4 s, while A is still fading.
    expect(t.started).toEqual(["A", "B"]);
    expect(t.engine.current!.item.title).toBe("B");
    const startedAt = t.engine.current!.startedAt - t.t0;
    expect(startedAt).toBeGreaterThan(3_700);
    expect(startedAt).toBeLessThan(4_300);
    expect(t.mixer.decks.automation.size).toBe(2);
    expect(t.ended).toEqual([]);
    // The old track finishes its built-in fade and leaves the mixer on its own.
    await t.run(2.1);
    expect(t.mixer.decks.automation.size).toBe(1);
    expect(t.ended.map((e) => e.title)).toContain("A");
    expect(t.engine.current!.item.title).toBe("B");
    t.engine.shutdown();
  }, 30_000);

  /** A library row with a loudness envelope: `level(t)` LUFS every 100 ms. */
  const withEnvelope = (
    t: ReturnType<typeof setup>,
    mediaId: number,
    seconds: number,
    level: (s: number) => number,
  ) => {
    const frames = Array.from({ length: seconds * 10 }, (_, i) => ({
      t: (i + 1) / 10,
      m: level((i + 1) / 10),
    }));
    t.source.mediaRows.set(mediaId, {
      id: mediaId,
      loudness_lufs: -12,
      loudness_envelope: encodeEnvelope(frames),
    } as MediaRow);
  };

  it("loud intro: the old track fades out within 1 s and the next starts at full level", async () => {
    const t = setup({ startOffset: 10 });
    t.source.hours.set(t.hourKey(B - 1), [
      item(files.s6!, 6, { title: "A", mediaId: 1, plannedStart: t.t0, fadeOut: 2 }),
      item(files.s4!, 4, { title: "B", mediaId: 2, plannedStart: t.t0 + 6000, fadeIn: 1 }),
    ]);
    // A's tail (from 4 s) is 15 LU down; B opens at full loudness.
    withEnvelope(t, 1, 6, (s) => (s <= 4 ? -12 : -27));
    withEnvelope(t, 2, 4, () => -12);
    t.engine.start();
    await t.run(4.15);
    expect(t.started).toEqual(["A", "B"]);
    expect(t.mixer.decks.automation.size).toBe(2);
    // B's own 1 s fade-in is skipped: it is at full level straight away.
    const b = t.engine.current!.deck;
    await t.run(0.2);
    expect(b.position).toBeLessThan(0.5);
    expect(t.mixer.lastRmsDb).toBeGreaterThan(-15);
    // A is gone after ~1 s, well before its natural end at 6 s.
    await t.run(1);
    expect(t.mixer.decks.automation.size).toBe(1);
    expect(t.ended.map((e) => e.title)).toContain("A");
    t.engine.shutdown();
  }, 30_000);

  it("quiet intro: the old track plays out its tail under it", async () => {
    const t = setup({ startOffset: 10 });
    t.source.hours.set(t.hourKey(B - 1), [
      item(files.s6!, 6, { title: "A", mediaId: 1, plannedStart: t.t0, fadeOut: 2 }),
      item(files.s4!, 4, { title: "B", mediaId: 2, plannedStart: t.t0 + 6000 }),
    ]);
    withEnvelope(t, 1, 6, (s) => (s <= 4 ? -12 : -27));
    withEnvelope(t, 2, 4, (s) => (s < 3 ? -40 : -12));
    t.engine.start();
    await t.run(5.3);
    // 1.3 s into the overlap A still plays (it holds ~1.5 s, then fades 0.5 s).
    expect(t.started).toEqual(["A", "B"]);
    expect(t.mixer.decks.automation.size).toBe(2);
    await t.run(1);
    expect(t.mixer.decks.automation.size).toBe(1);
    expect(t.ended.map((e) => e.title)).toContain("A");
    t.engine.shutdown();
  }, 30_000);

  it("keeps fallback music queued (and preloaded) when the hour has no plan", async () => {
    const t = setup({ startOffset: 60 });
    t.source.fillers = [item(files.s2!, 2, { title: "F1" }), item(files.s2!, 2, { title: "F2" })];
    t.engine.start();
    for (let i = 0; i < 4; i += 1) {
      await t.run(1.5);
      expect(t.engine.queue.length).toBeGreaterThan(0);
    }
    expect(t.started.length).toBeGreaterThanOrEqual(3);
    t.engine.shutdown();
  }, 30_000);

  it("does not crossfade into a new song when the news is due within the tolerance", async () => {
    const t = setup({ startOffset: 10 });
    t.source.hours.set(t.hourKey(B - 1), [
      item(files.s6!, 6, { title: "A", plannedStart: t.t0, fadeOut: 2 }),
      item(files.s4!, 4, { title: "B", plannedStart: t.t0 + 6000 }),
    ]);
    t.source.hours.set(t.hourKey(B), [news()]);
    t.engine.start();
    // A ends 4 s before the news (tolerance 5 s): rule 4 starts the news early, B is skipped.
    await t.run(7);
    expect(t.started).toEqual(["A", "News 11"]);
    t.engine.shutdown();
  }, 30_000);

  it("starts the first song under the fading tail of the news", async () => {
    const t = setup({ startOffset: 0.5 });
    t.source.hours.set(t.hourKey(B), [
      item(files.news!, 3, {
        kind: "news",
        title: "News 11",
        locked: true,
        plannedStart: B,
        fadeOut: 1,
      }),
      item(files.s4!, 4, { title: "C", plannedStart: B + 3000 }),
    ]);
    t.engine.start();
    await t.run(0.2);
    expect(t.started).toEqual(["News 11"]);
    const newsStart = t.engine.current!.startedAt - t.t0;
    // C comes in 1 s before the news ends, while the news is still fading.
    await t.run((newsStart + 2150) / 1000 - 0.2);
    expect(t.started).toEqual(["News 11", "C"]);
    expect(t.mixer.decks.automation.size).toBe(2);
    t.engine.shutdown();
  }, 30_000);

  it("does not crossfade into a locked news block", async () => {
    const t = setup({ startOffset: 10 });
    t.source.hours.set(t.hourKey(B - 1), [
      item(files.s6!, 6, { title: "A", plannedStart: t.t0, fadeOut: 2 }),
    ]);
    t.source.hours.set(t.hourKey(B), [news()]);
    t.engine.start();
    await t.run(4.15);
    expect(t.started).toEqual(["A"]);
    expect(t.mixer.decks.automation.size).toBe(1);
    t.engine.shutdown();
  }, 30_000);
});
