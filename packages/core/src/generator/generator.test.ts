import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEMPLATE,
  GENERATOR_SETTINGS_DEFAULTS,
  type GeneratorSettings,
} from "@radio/shared";
import {
  generateHour,
  mulberry32,
  hashSeed,
  type Candidate,
  type GenerateHourInput,
} from "./generator.js";
import { SeparationTracker, normalizeArtist } from "./separation.js";
import { generationGuard, hourStartMs } from "../time.js";

const TZ = "Europe/Amsterdam";

function library(n: number, artists = Math.ceil(n / 3), seed = 1): Candidate[] {
  const rnd = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => ({
    mediaId: i + 1,
    artist: `Artist ${i % artists}`,
    title: `Track ${i + 1}`,
    duration: Math.round(150 + rnd() * 150), // 2:30–5:00
    playlistId: 1,
    weight: 1,
    playCount: 0,
  }));
}

const news = (id: number, duration = 180): Candidate => ({
  mediaId: id,
  artist: "News",
  title: `News ${id}`,
  duration,
  playlistId: 2,
  weight: 1,
  playCount: 0,
});

function input(
  overrides: Partial<GenerateHourInput> = {},
  settings: Partial<GeneratorSettings> = {},
): GenerateHourInput {
  const s = { ...GENERATOR_SETTINGS_DEFAULTS, ...settings };
  return {
    date: "2030-03-12",
    hour: 14,
    hourStartMs: hourStartMs("2030-03-12", 14, TZ)!,
    blocks: DEFAULT_TEMPLATE,
    settings: s,
    pools: { music: library(400) },
    news: { hour: news(9001), half: news(9002) },
    separation: new SeparationTracker(s.separation_track_hours, s.separation_artist_hours),
    ...overrides,
  };
}

describe("generateHour (M3.3)", () => {
  it("places locked news at :00 and :30 and fills both music blocks", () => {
    const r = generateHour(input());
    const newsItems = r.items.filter((i) => i.kind === "news");
    expect(newsItems.map((i) => i.startSeconds)).toEqual([0, 1800]);
    expect(newsItems.every((i) => i.locked)).toBe(true);
    expect(r.items.filter((i) => i.kind === "music").length).toBeGreaterThan(8);
    expect(r.warnings).toEqual([]);
  });

  it("keeps the hour within hour_min/hour_max and music blocks end within tolerance of the next lock", () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const r = generateHour(input({ hour, hourStartMs: hourStartMs("2030-03-12", hour, TZ)! }));
      expect(r.totalSeconds).toBeGreaterThanOrEqual(3540);
      expect(r.totalSeconds).toBeLessThanOrEqual(3720);
      const block1 = r.items.filter((i) => i.blockId === "music-1");
      const end1 = block1.at(-1)!.startSeconds + block1.at(-1)!.length;
      expect(Math.abs(end1 - 1800)).toBeLessThanOrEqual(45);
    }
  });

  it("is deterministic for the same inputs", () => {
    const a = generateHour(input());
    const b = generateHour(input());
    expect(a.items.map((i) => i.mediaId)).toEqual(b.items.map((i) => i.mediaId));
    const c = generateHour(input({ seed: "other" }));
    expect(c.items.map((i) => i.mediaId)).not.toEqual(a.items.map((i) => i.mediaId));
  });

  it("honours track (4 h) and artist (1 h) separation across a generated day (property)", () => {
    const s = GENERATOR_SETTINGS_DEFAULTS;
    const sep = new SeparationTracker(s.separation_track_hours, s.separation_artist_hours);
    const pool = library(600, 200, 7);
    const plays: { id: number; artist: string; at: number }[] = [];
    for (let hour = 0; hour < 24; hour += 1) {
      const start = hourStartMs("2030-03-12", hour, TZ)!;
      const r = generateHour(
        input({ hour, hourStartMs: start, separation: sep, pools: { music: pool } }),
      );
      expect(r.stats.relaxed).toBe(0);
      for (const item of r.items.filter((i) => i.kind === "music"))
        plays.push({
          id: item.mediaId!,
          artist: item.artist!,
          at: start + item.startSeconds * 1000,
        });
    }
    for (let i = 0; i < plays.length; i += 1) {
      for (let j = i + 1; j < plays.length; j += 1) {
        const dt = Math.abs(plays[j]!.at - plays[i]!.at);
        if (plays[i]!.id === plays[j]!.id) expect(dt).toBeGreaterThanOrEqual(4 * 3_600_000);
        if (plays[i]!.artist === plays[j]!.artist) expect(dt).toBeGreaterThanOrEqual(3_600_000);
      }
    }
  });

  it("uses tail closers/completers to land on the boundary", () => {
    let closers = 0;
    let completers = 0;
    for (let hour = 0; hour < 24; hour += 1) {
      const r = generateHour(input({ hour }));
      closers += r.stats.closers;
      completers += r.stats.completers;
    }
    expect(closers + completers).toBeGreaterThan(24);
  });

  it("allows overrun up to the tail limit but never beyond tail+overrun", () => {
    // Only long tracks: forces overruns.
    const pool = Array.from({ length: 60 }, (_, i) => ({
      ...library(1)[0]!,
      mediaId: i + 1,
      artist: `A${i}`,
      duration: 400 + (i % 7) * 13,
    }));
    const r = generateHour(input({ pools: { music: pool } }));
    for (const block of ["music-1", "music-2"]) {
      const items = r.items.filter((i) => i.blockId === block);
      const end = items.at(-1)!.startSeconds + items.at(-1)!.length;
      const lock = block === "music-1" ? 1800 : 3600;
      expect(end - lock).toBeLessThanOrEqual(
        GENERATOR_SETTINGS_DEFAULTS.overrun_allowed_seconds + 45,
      );
    }
  });

  it("relaxes separation with a warning rather than leaving dead air (fill fallback)", () => {
    const tiny = library(6, 2);
    const r = generateHour(input({ pools: { music: tiny } }));
    expect(r.items.filter((i) => i.kind === "music").length).toBeGreaterThan(6);
    expect(r.warnings.some((w) => /relaxed|repeats/.test(w))).toBe(true);
  });

  it("warns when news media is missing and when no music exists", () => {
    const r = generateHour(input({ news: { hour: null, half: null }, pools: { music: [] } }));
    expect(r.warnings.some((w) => w.includes("news media not found"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("no music candidates"))).toBe(true);
  });

  it("supports live and jingle blocks in overrides", () => {
    const r = generateHour(
      input({
        blocks: [
          { id: "news-00", type: "news", start: 0, end: 3, locked: true },
          { id: "jingle", type: "jingle", start: 3, end: 4 },
          { id: "live", type: "live", start: 4, end: 60, locked: true },
        ],
        pools: {
          music: library(50),
          jingles: [{ ...news(7000, 8), artist: "Station", title: "ID" }],
        },
      }),
    );
    expect(r.items.map((i) => i.kind)).toEqual(["news", "jingle", "live"]);
  });

  it("penalizes heavily played tracks", () => {
    const pool = library(40, 40).map((c) => ({ ...c, playCount: c.mediaId <= 20 ? 50 : 0 }));
    const counts = { hot: 0, fresh: 0 };
    for (let hour = 0; hour < 12; hour += 1) {
      const r = generateHour(
        input({ hour, pools: { music: pool }, separation: new SeparationTracker(0, 0) }),
      );
      for (const i of r.items.filter((x) => x.kind === "music" && x.reason === "fill"))
        counts[i.mediaId! <= 20 ? "hot" : "fresh"] += 1;
    }
    expect(counts.fresh).toBeGreaterThan(counts.hot * 3);
  });
});

describe("SeparationTracker (M3.2)", () => {
  it("allows a repeat at exactly 4 h and blocks one at 4 h − 1 s", () => {
    const t0 = Date.UTC(2030, 0, 1, 10);
    const sep = new SeparationTracker(4, 1, [{ mediaId: 1, artist: "X", at: t0 }]);
    expect(sep.trackOk(1, t0 + 4 * 3_600_000)).toBe(true);
    expect(sep.trackOk(1, t0 + 4 * 3_600_000 - 1000)).toBe(false);
    expect(sep.artistOk("x", t0 + 3_600_000)).toBe(true);
    expect(sep.artistOk("The X", t0 + 1000)).toBe(false);
  });

  it("measures real elapsed time across the DST change", () => {
    // 2030-03-31 is spring-forward in Europe/Amsterdam: 01:00 → 03:00 local is only 1 real hour.
    const one = hourStartMs("2030-03-31", 1, TZ)!;
    const three = hourStartMs("2030-03-31", 3, TZ)!;
    expect(three - one).toBe(3_600_000);
    expect(hourStartMs("2030-03-31", 2, TZ)).toBeNull();
    const sep = new SeparationTracker(4, 1, [{ mediaId: 1, artist: "X", at: one }]);
    expect(sep.artistOk("X", three)).toBe(true); // 1 real hour later
    const five = hourStartMs("2030-03-31", 5, TZ)!;
    expect(sep.trackOk(1, five)).toBe(false); // only 3 real hours later
  });

  it("normalizes artist names for matching", () => {
    expect(normalizeArtist("The Beatles")).toBe(normalizeArtist("beatles"));
    expect(normalizeArtist("Daft Punk feat. Pharrell")).toBe("daft punk");
    expect(normalizeArtist("Beyoncé")).toBe("beyonce");
  });
});

describe("guards (M3.5)", () => {
  const now = hourStartMs("2030-03-12", 14, TZ)! + 10 * 60_000; // 14:10
  it("never rewrites the on-air hour or past hours", () => {
    expect(generationGuard("2030-03-12", 14, TZ, now)).toBe("on_air");
    expect(generationGuard("2030-03-12", 13, TZ, now)).toBe("past");
    expect(generationGuard("2030-03-12", 15, TZ, now)).toBe("ok");
    expect(generationGuard("2030-03-13", 0, TZ, now)).toBe("ok");
    expect(generationGuard("2030-03-31", 2, TZ, now)).toBe("nonexistent");
  });
  it("seeds are stable", () => {
    expect(hashSeed("abc")).toBe(hashSeed("abc"));
    expect(hashSeed("abc")).not.toBe(hashSeed("abd"));
  });
});
