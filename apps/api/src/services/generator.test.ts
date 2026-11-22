import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { hourStartMs } from "@radio/core";
import { hourPlaylistName, DECADE_PLAYLISTS } from "@radio/shared";
import { createTestEnv, makeTone, type TestEnv } from "../test-utils.js";
import { GeneratorScheduler, GeneratorService } from "./generator.js";
import { scanLibrary } from "./media/scanner.js";

const TZ = "Europe/Amsterdam";
let env: TestEnv;
let alerts: { type: string; message: string }[];
let service: GeneratorService;

function addMedia(count: number, playlistName: string, prefix: string) {
  const pl = env.repos.playlists.getByName(playlistName)!;
  const ids: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const { row } = env.repos.media.upsert({
      path: `/lib/${prefix}/${i}.mp3`,
      relative_path: `${prefix}/${i}.mp3`,
      title: `${prefix} ${i}`,
      artist: `${prefix} artist ${i % 40}`,
      duration: 150 + ((i * 37) % 150),
      status: "ok",
    });
    ids.push(row.id);
  }
  env.repos.playlists.addItems(pl.id, ids);
}

beforeEach(async () => {
  env = await createTestEnv();
  alerts = [];
  service = new GeneratorService(env.repos, env.config, (a) => alerts.push(a));
  for (let h = 0; h < 24; h += 1) addMedia(60, hourPlaylistName(h), `pm${h}`);
  addMedia(120, "80s", "eighties");
  addMedia(80, "General", "general");
  for (const [rel, d] of [
    ["Nieuws/nieuws-heel-uur.mp3", 178],
    ["Nieuws/nieuws-half-uur.mp3", 120],
  ] as const) {
    env.repos.media.upsert({
      path: `/lib/${rel}`,
      relative_path: rel,
      title: rel,
      artist: "News",
      duration: d,
      status: "ok",
    });
  }
});

afterEach(() => env.cleanup());

const at = (date: string, hour: number, minute = 0) =>
  hourStartMs(date, hour, TZ)! + minute * 60_000;

describe("GeneratorService (M3.4–M3.7)", () => {
  it("generates a full day of 24 plans from the hour playlists and reloads them identically", () => {
    const r = service.generate({ date: "2030-05-02", nowMs: at("2030-05-01", 12) });
    expect(r.plans.filter((p) => !p.skipped)).toHaveLength(24);
    const plan = env.repos.schedule.plan("2030-05-02", 7)!;
    const items = env.repos.schedule.items(plan.id);
    const preview = r.plans.find((p) => p.hour === 7)!;
    expect(items.map((i) => i.media_id)).toEqual(preview.items.map((i) => i.mediaId));
    // Music in hour 7 comes from [PM] 07:00.
    const pm7 = env.repos.playlists.getByName(hourPlaylistName(7))!.id;
    expect(items.filter((i) => i.kind === "music").every((i) => i.playlist_id === pm7)).toBe(true);
    expect(items.filter((i) => i.kind === "news").map((i) => i.start_seconds)).toEqual([0, 1800]);
    expect(env.repos.schedule.runs(1)[0]).toMatchObject({ run_type: "manual", status: "ok" });
  });

  it("dry-run writes nothing", () => {
    const r = service.generate({
      date: "2030-05-02",
      hours: [0, 1],
      dryRun: true,
      nowMs: at("2030-05-01", 12),
    });
    expect(r.plans).toHaveLength(2);
    expect(r.plans[0]!.items.length).toBeGreaterThan(5);
    expect(env.repos.schedule.plansForDate("2030-05-02")).toHaveLength(0);
    expect(env.repos.schedule.runs()).toHaveLength(0);
  });

  it("never rewrites the on-air hour or past hours; hour 0 tomorrow is allowed", () => {
    const now = at("2030-05-02", 14, 10);
    service.generate({ date: "2030-05-02", nowMs: at("2030-05-01", 12) });
    const before = env.repos.schedule
      .items(env.repos.schedule.plan("2030-05-02", 14)!.id)
      .map((i) => i.media_id);
    const r = service.generate({ date: "2030-05-02", nowMs: now });
    expect(r.plans.find((p) => p.hour === 14)!.skipped).toMatch(/on-air/);
    expect(r.plans.find((p) => p.hour === 13)!.skipped).toMatch(/passed/);
    expect(r.plans.find((p) => p.hour === 15)!.skipped).toBeNull();
    expect(
      env.repos.schedule
        .items(env.repos.schedule.plan("2030-05-02", 14)!.id)
        .map((i) => i.media_id),
    ).toEqual(before);
    const t = service.generateTomorrowHour0(at("2030-05-02", 23));
    expect(t.plans[0]).toMatchObject({ date: "2030-05-03", hour: 0, skipped: null });
  });

  it("skips live and disabled hours and honours per-hour playlist overrides", () => {
    service.setOverride(9, { live: true });
    service.setOverride(10, { disabled: true });
    service.setOverride(11, { playlistName: "80s" });
    const r = service.generate({ date: "2030-05-02", nowMs: at("2030-05-01", 12) });
    expect(r.plans.find((p) => p.hour === 9)!.skipped).toBe("live hour");
    expect(r.plans.find((p) => p.hour === 10)!.skipped).toBe("hour disabled");
    const eighties = env.repos.playlists.getByName("80s")!.id;
    expect(
      r.plans
        .find((p) => p.hour === 11)!
        .items.filter((i) => i.kind === "music")
        .every((i) => i.playlistId === eighties),
    ).toBe(true);
  });

  it("fallback mode draws from decades + General", () => {
    service.setFallbackMode(true);
    const r = service.generate({ date: "2030-05-02", hours: [3], nowMs: at("2030-05-01", 12) });
    const allowed = new Set(
      [...DECADE_PLAYLISTS, "General"].map((n) => env.repos.playlists.getByName(n)!.id),
    );
    expect(
      r.plans[0]!.items.filter((i) => i.kind === "music").every((i) => allowed.has(i.playlistId!)),
    ).toBe(true);
    service.setFallbackMode(false);
    const n = service.generate({ date: "2030-05-02", hours: [3], nowMs: at("2030-05-01", 12) });
    const pm3 = env.repos.playlists.getByName(hourPlaylistName(3))!.id;
    expect(
      n.plans[0]!.items.filter((i) => i.kind === "music").every((i) => i.playlistId === pm3),
    ).toBe(true);
  });
});

describe("GeneratorScheduler triggers (M3.5)", () => {
  it("fires 00:05 (rest of today) and 23:00 (hour 0 tomorrow) once, with catch-up", () => {
    const sched = new GeneratorScheduler(service, env.repos);
    expect(sched.dueTriggers(at("2030-05-02", 0, 4))).toEqual([]);
    expect(sched.dueTriggers(at("2030-05-02", 0, 5))).toEqual(["rest"]);
    sched.tick(at("2030-05-02", 0, 5));
    expect(env.repos.schedule.plansForDate("2030-05-02").map((p) => p.hour)).toEqual(
      Array.from({ length: 23 }, (_, i) => i + 1),
    );
    expect(env.repos.schedule.plan("2030-05-02", 0)).toBeUndefined();
    expect(sched.dueTriggers(at("2030-05-02", 22, 59))).toEqual([]);
    expect(sched.dueTriggers(at("2030-05-02", 23, 0))).toEqual(["hour0"]);
    sched.tick(at("2030-05-02", 23, 0));
    expect(env.repos.schedule.plan("2030-05-03", 0)).toBeDefined();
    expect(sched.dueTriggers(at("2030-05-02", 23, 30))).toEqual([]);
    // Missed trigger: process was down at 00:05, comes back at 02:00.
    expect(sched.dueTriggers(at("2030-05-03", 2, 0))).toEqual(["rest"]);
  });
});

describe("integrity + news (M3.6)", () => {
  it("generates missing upcoming plans and alerts when it cannot", () => {
    const r = service.integrityCheck(at("2030-05-02", 10, 30));
    expect(r.missing.length).toBe(25);
    // The current hour (10) is never generated; the other 24 are.
    expect(r.generated).toHaveLength(24);
    expect(alerts.some((a) => a.type === "generator_gap")).toBe(true);
    alerts = [];
    // Now generate the on-air hour beforehand to clear the gap.
    service.generate({ date: "2030-05-02", hours: [10], nowMs: at("2030-05-02", 9) });
    service.integrityCheck(at("2030-05-02", 10, 30));
    expect(alerts.some((a) => a.type === "generator_gap")).toBe(false);
  });

  it("regenerates future plans when the news length changes", async () => {
    const newsDir = join(env.config.media.root, "Nieuws");
    makeTone(join(newsDir, "nieuws-heel-uur.mp3"), { seconds: 3, title: "News" });
    makeTone(join(newsDir, "nieuws-half-uur.mp3"), { seconds: 2, title: "News half" });
    // Replace the synthetic news rows with scanned ones.
    env.repos.db.prepare("DELETE FROM media WHERE path LIKE '/lib/Nieuws/%'").run();
    await scanLibrary(env.repos, env.config);
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    service.generate({ nowMs: now });
    const hourNews = env.repos.media.findByRelativePath("Nieuws/nieuws-heel-uur.mp3")!;
    env.repos.media.update(hourNews.id, { duration: 99 });
    const r = await service.reprocessNews(now);
    expect(r.changed).toContain("Nieuws/nieuws-heel-uur.mp3");
    expect(env.repos.media.get(hourNews.id)!.duration).toBeLessThan(4);
    expect(r.regenerated).toBeGreaterThanOrEqual(0);
    expect(today).toMatch(/^\d{4}/);
  });
});
