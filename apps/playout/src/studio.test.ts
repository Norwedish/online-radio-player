import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveBus } from "./audio/live-bus.js";
import { Mixer } from "./audio/mixer.js";
import { PlayoutEngine } from "./engine.js";
import { FakePlanSource, item, tone } from "./test-utils.js";

let dir: string;
const files: Record<string, string> = {};
const HOUR = Date.UTC(2030, 0, 1, 10);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "radio-studio-"));
  for (const [name, secs, freq] of [
    ["auto", 40, 300],
    ["a", 3, 500],
    ["b", 3, 700],
    ["long", 20, 600],
    ["jingle", 1, 900],
  ] as const) {
    files[name] = tone(dir, name, secs, freq, 0.3);
  }
});
// Every engine is shut down even when a test fails, so no FFmpeg keeps the files open.
const engines: PlayoutEngine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.shutdown();
});
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

function setup() {
  const source = new FakePlanSource("UTC");
  const live = new LiveBus(20);
  const mixer = new Mixer(live, { duckDb: -12, duckAttackMs: 20, duckReleaseMs: 200 });
  // 10:20 — the next hour boundary is far away.
  const t0 = HOUR + 20 * 60_000;
  const now = () => t0 + mixer.framesMixed / 48;
  const alerts: string[] = [];
  const engine = new PlayoutEngine({
    source,
    mixer,
    now,
    toleranceSeconds: 5,
    silenceThresholdDb: -60,
    silenceSeconds: 10,
    emergencyFile: join(dir, "nope.mp3"),
    autoTick: false,
    autoRecoverSeconds: 0,
    alert: (a) => alerts.push(a.type),
  });
  engines.push(engine);
  const started: string[] = [];
  engine.on("worker-event", (type: string, payload: { item?: { title: string } }) => {
    if (type === "track_started") started.push(payload.item!.title);
  });
  const levels: Record<string, number> = {};
  const run = async (seconds: number) => {
    const blocks = Math.round(seconds * 100);
    for (let i = 0; i < blocks; i += 1) {
      const starving = () =>
        Object.values(mixer.decks).some((set) =>
          [...set].some((d) => (d.state === "playing" || d.state === "loading") && !d.ready),
        ) || mixer.studio.some((s) => s.starving());
      for (let w = 0; w < 200 && starving(); w += 1) await new Promise((r) => setTimeout(r, 2));
      mixer.render(480);
      engine.onRendered(mixer.lastRmsDb, 480);
      if (i % 10 === 0) {
        engine.tick();
        // Sample the 10 Hz meters like the worker does.
        const m = mixer.readMeters();
        for (const b of m.buses) levels[b.name] = Math.max(levels[b.name] ?? -120, b.peak);
        for (const p of m.players ?? [])
          levels[`player:${p.id}`] = Math.max(levels[`player:${p.id}`] ?? -120, p.peak);
      }
      if (i % 20 === 0) await new Promise((r) => setImmediate(r));
    }
  };
  const resetLevels = () => {
    for (const k of Object.keys(levels)) delete levels[k];
  };
  const automation = () => {
    source.hours.set("2030-01-01:10", [item(files.auto!, 40, { title: "Auto", plannedStart: t0 })]);
  };
  return { engine, source, mixer, run, started, alerts, levels, resetLevels, automation };
}

const player = (e: PlayoutEngine, id: "A" | "B") =>
  e.getState().studio.players.find((p) => p.id === id)!;

describe("studio players + manual mode", () => {
  it("playing a player takes over: automation fades out and holds, hand-back resumes it", async () => {
    const t = setup();
    t.automation();
    t.engine.start();
    await t.run(2);
    expect(t.started).toEqual(["Auto"]);
    expect(t.engine.getState().mode).toBe("autoplay");

    t.engine.studioLoad("A", item(files.long!, 20, { title: "Player A" }));
    expect(player(t.engine, "A").status).toBe("loaded");
    t.engine.studioCommand("A", "play");
    expect(t.engine.getState().mode).toBe("manual");
    expect(t.engine.getState().studio.manual).toBe(true);
    await t.run(1.5);
    t.resetLevels();
    await t.run(2);
    // Automation is silent (faded out and held), the player is on air.
    expect(t.levels.automation ?? -120).toBeLessThan(-60);
    expect(t.levels["player:A"]).toBeGreaterThan(-20);
    expect(t.engine.getState().nowPlaying).toBeNull();
    expect(player(t.engine, "A").position).toBeGreaterThan(3);

    t.engine.setManual(false);
    expect(t.engine.getState().studio.manual).toBe(false);
    await t.run(3);
    // The held automation track resumes; the player faded out and is back at its cue point.
    expect(t.started.slice(-1)[0]).toBe("Auto");
    expect(t.engine.getState().nowPlaying?.title).toBe("Auto");
    expect(player(t.engine, "A").status).toBe("loaded");
    expect(player(t.engine, "A").position).toBe(0);
    t.engine.shutdown();
  });

  it("stop returns to the cue point, play starts from it", async () => {
    const t = setup();
    t.engine.start();
    t.engine.studioLoad("A", item(files.long!, 20, { title: "Cue" }), undefined, 5);
    expect(player(t.engine, "A").position).toBe(5);
    t.engine.studioCommand("A", "play");
    await t.run(1);
    expect(player(t.engine, "A").position).toBeGreaterThan(5.8);
    t.engine.studioCommand("A", "stop");
    expect(player(t.engine, "A").status).toBe("loaded");
    expect(player(t.engine, "A").position).toBe(5);
    // Pause keeps the position.
    t.engine.studioCommand("A", "play");
    await t.run(1);
    t.engine.studioCommand("A", "pause");
    await t.run(0.5);
    const paused = player(t.engine, "A").position;
    await t.run(1);
    expect(player(t.engine, "A").status).toBe("paused");
    expect(Math.abs(player(t.engine, "A").position - paused)).toBeLessThan(0.1);
    t.engine.shutdown();
  });

  it("auto-next starts the other player when one ends", async () => {
    const t = setup();
    t.engine.start();
    t.engine.studioLoad("A", item(files.a!, 3, { title: "A" }));
    t.engine.studioLoad("B", item(files.b!, 3, { title: "B" }));
    t.engine.studio.player("A").set({ autoNext: true });
    t.engine.studioCommand("A", "play");
    await t.run(3.5);
    expect(player(t.engine, "A").status).toBe("loaded");
    expect(player(t.engine, "B").status).toBe("playing");
    t.engine.shutdown();
  });

  it("fade-out with auto-next overlaps into the other player (manual crossfade)", async () => {
    const t = setup();
    t.engine.start();
    t.engine.studioLoad("A", item(files.long!, 20, { title: "A" }));
    t.engine.studioLoad("B", item(files.long!, 20, { title: "B" }));
    t.engine.studio.player("A").set({ autoNext: true });
    t.engine.studioCommand("A", "play");
    await t.run(1);
    t.engine.studio.player("A").fade(1);
    expect(player(t.engine, "A").fading).toBe(true);
    expect(player(t.engine, "B").status).toBe("playing");
    await t.run(1.5);
    expect(player(t.engine, "A").status).toBe("loaded");
    expect(player(t.engine, "A").fading).toBe(false);
    expect(player(t.engine, "B").status).toBe("playing");
    t.engine.shutdown();
  });

  it("loop restarts at the cue point and keeps playing", async () => {
    const t = setup();
    t.engine.start();
    t.engine.studioLoad("A", item(files.a!, 3, { title: "Loop" }), undefined, 1);
    t.engine.studio.player("A").set({ loop: true });
    t.engine.studioCommand("A", "play");
    await t.run(4);
    const p = player(t.engine, "A");
    expect(p.status).toBe("playing");
    // 1 → 3 s (2 s), then again from 1 s: after 4 s of audio we are around 1 + 2 = 3 → 1 + 0..
    expect(p.position).toBeGreaterThanOrEqual(1);
    expect(p.position).toBeLessThan(3);
    t.engine.shutdown();
  });

  it("player fader and meters are per player", async () => {
    const t = setup();
    t.engine.start();
    t.engine.studioLoad("A", item(files.long!, 20, { title: "Loud" }));
    t.engine.studioLoad("B", item(files.long!, 20, { title: "Quiet" }));
    t.engine.studio.player("B").set({ gainDb: -20 });
    t.engine.studioCommand("A", "play");
    t.engine.studioCommand("B", "play");
    await t.run(1);
    t.resetLevels();
    await t.run(1);
    expect(t.levels["player:A"]! - t.levels["player:B"]!).toBeGreaterThan(18);
    t.engine.shutdown();
  });

  it("carts overlap automation without switching to manual", async () => {
    const t = setup();
    t.automation();
    t.engine.start();
    await t.run(1);
    t.engine.studio.carts.fire(item(files.jingle!, 1, { title: "Jingle", kind: "jingle" }));
    expect(t.engine.getState().studio.carts).toHaveLength(1);
    t.resetLevels();
    await t.run(0.5);
    expect(t.engine.getState().studio.manual).toBe(false);
    expect(t.levels.automation).toBeGreaterThan(-20);
    expect(t.levels["player:carts"]).toBeGreaterThan(-20);
    await t.run(1);
    expect(t.engine.getState().studio.carts).toHaveLength(0);
    t.engine.shutdown();
  });

  it("loads a queued item into a player and removes it from the queue", async () => {
    const t = setup();
    t.source.hours.set("2030-01-01:10", [
      item(files.auto!, 40, { title: "Now", plannedStart: HOUR + 20 * 60_000 }),
      item(files.long!, 20, { title: "Next", plannedStart: HOUR + 20 * 60_000 + 40_000 }),
    ]);
    t.engine.start();
    await t.run(0.5);
    const next = t.engine.queue.find((q) => q.title === "Next")!;
    t.engine.studioLoad("B", null, next.uid);
    expect(t.engine.queue.some((q) => q.uid === next.uid)).toBe(false);
    expect(player(t.engine, "B").item?.title).toBe("Next");
    t.engine.shutdown();
  });

  it("refuses play-now in manual mode and cannot load over an on-air player", async () => {
    const t = setup();
    t.engine.start();
    t.engine.studioLoad("A", item(files.long!, 20));
    t.engine.studioCommand("A", "play");
    expect(() => t.engine.playNow(item(files.jingle!, 1))).toThrow(/manual mode/);
    expect(() => t.engine.studioLoad("A", item(files.a!, 3))).toThrow(/on air/);
    t.engine.shutdown();
  });

  it("long silence in manual mode hands the station back to automation", async () => {
    const t = setup();
    t.automation();
    t.engine.start();
    await t.run(0.5);
    t.engine.setManual(true);
    expect(t.engine.getState().mode).toBe("manual");
    await t.run(62);
    expect(t.alerts).toContain("manual_dead_air");
    expect(t.engine.getState().studio.manual).toBe(false);
    expect(t.engine.getState().nowPlaying?.title).toBe("Auto");
    t.engine.shutdown();
  }, 60_000);
});
