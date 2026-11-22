import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gainToDb } from "@radio/core";
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
afterAll(() => rmSync(dir, { recursive: true, force: true }));

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
  engine.on("worker-event", (type: string, payload: { item?: { title: string } }) => {
    if (type === "track_started") started.push(payload.item!.title);
  });
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
  return { source, mixer, engine, now, run, started, alerts, t0, hourKey };
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
