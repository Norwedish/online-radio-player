import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, makeTone, type TestEnv } from "../../test-utils.js";
import { analyzeMedia, analyzePending, gainFor } from "./loudness.js";
import { applySuggestion, parseRecordings, suggestForMedia } from "./metadata-lookup.js";
import { parseFilename } from "./probe.js";
import { importFile, isIgnoredName, scanLibrary } from "./scanner.js";
import { MediaWatcher } from "./watcher.js";

let env: TestEnv;
let root: string;

beforeAll(async () => {
  env = await createTestEnv();
  root = env.config.media.root;
  makeTone(join(root, "General", "Tagged.mp3"), { seconds: 2, title: "Song A", artist: "Band A" });
  makeTone(join(root, "General", "Band B - Song B.mp3"), { seconds: 2 });
  makeTone(join(root, "Jingles", "covered.mp3"), {
    seconds: 1,
    title: "ID",
    artist: "Station",
    cover: true,
  });
  makeTone(join(root, "Nieuws", "nieuws-heel-uur.flac"), {
    seconds: 3,
    format: "flac",
    title: "News",
  });
  // Exact duplicate (same bytes) and a near duplicate (same tags, re-encoded).
  mkdirSync(join(root, "80s"), { recursive: true });
  copyFileSync(join(root, "General", "Tagged.mp3"), join(root, "80s", "Tagged copy.mp3"));
  makeTone(join(root, "Other", "Tagged again.mp3"), {
    seconds: 2,
    frequency: 440,
    title: "Song A",
    artist: "band a",
  });
  mkdirSync(join(root, "@eaDir"), { recursive: true });
  makeTone(join(root, "@eaDir", "thumb.mp3"), { seconds: 1 });
  writeFileSync(join(root, "General", "broken.mp3"), "not audio at all");
  writeFileSync(join(root, "General", ".hidden.mp3"), "x");
}, 60_000);

afterAll(() => env.cleanup());

describe("media scanner (M2.1–M2.3)", () => {
  it("imports tags, falls back to the filename and skips ignored folders", async () => {
    const report = await scanLibrary(env.repos, env.config);
    expect(report.files).toBe(7); // @eaDir and dotfiles ignored
    expect(report.created).toBe(7);
    const tagged = env.repos.media.findByRelativePath("General/Tagged.mp3")!;
    expect(tagged).toMatchObject({
      title: "Song A",
      artist: "Band A",
      status: "ok",
      codec: "mpeg 1 layer 3",
    });
    expect(tagged.duration).toBeGreaterThan(1.9);
    expect(tagged.sample_rate).toBe(48_000);
    expect(tagged.hash).toMatch(/^[0-9a-f]{40}$/);
    const named = env.repos.media.findByRelativePath("General/Band B - Song B.mp3")!;
    expect(named).toMatchObject({ artist: "Band B", title: "Song B" });
    expect(named.tags.tagsMissing).toBe(true);
    const flac = env.repos.media.findByRelativePath("Nieuws/nieuws-heel-uur.flac")!;
    expect(flac).toMatchObject({ title: "News", codec: "flac" });
    const broken = env.repos.media.findByRelativePath("General/broken.mp3")!;
    expect(broken.status).toBe("error");
    expect(report.errors.some((e) => e.includes("broken.mp3"))).toBe(true);
  }, 30_000);

  it("adds files to the playlist named after their folder", () => {
    const items = (name: string) =>
      env.repos.playlists
        .items(env.repos.playlists.getByName(name)!.id)
        .map((i) => i.media.relative_path);
    expect(items("General")).toEqual(
      expect.arrayContaining(["General/Tagged.mp3", "General/Band B - Song B.mp3"]),
    );
    expect(items("Jingles")).toEqual(["Jingles/covered.mp3"]);
    expect(items("Nieuws")).toEqual(["Nieuws/nieuws-heel-uur.flac"]);
    expect(items("80s")).toEqual(["80s/Tagged copy.mp3"]);
  });

  it("caches embedded artwork", () => {
    const m = env.repos.media.findByRelativePath("Jingles/covered.mp3")!;
    expect(m.artwork_path).toBeTruthy();
    expect(existsSync(m.artwork_path!)).toBe(true);
    expect(m.artwork_path!.startsWith(env.config.media.artworkDir)).toBe(true);
  });

  it("detects exact and near duplicates", () => {
    const groups = env.repos.media.duplicateGroups();
    const exact = groups.find((g) => g.kind === "hash")!;
    expect(exact.items.map((i) => i.relative_path).sort()).toEqual([
      "80s/Tagged copy.mp3",
      "General/Tagged.mp3",
    ]);
    const near = groups.find((g) => g.kind === "metadata")!;
    expect(near.items.map((i) => i.relative_path)).toContain("Other/Tagged again.mp3");
  });

  it("skips unchanged files on rescan and marks deleted files missing", async () => {
    rmSync(join(root, "Other", "Tagged again.mp3"));
    const report = await scanLibrary(env.repos, env.config);
    expect(report.created).toBe(0);
    expect(report.unchanged).toBe(6);
    expect(report.missing).toBe(1);
    expect(env.repos.media.findByRelativePath("Other/Tagged again.mp3")!.status).toBe("missing");
  }, 30_000);

  it("keeps operator tag edits when a changed file is re-imported", async () => {
    const m = env.repos.media.findByRelativePath("General/Tagged.mp3")!;
    env.repos.media.update(m.id, { title: "Edited", tags: { ...m.tags, edited: true } });
    const { row } = await importFile(env.repos, env.config, m.path, undefined, { force: true });
    expect(row.title).toBe("Edited");
  });

  it("parses filenames and ignores temp files", () => {
    expect(parseFilename("/x/01 - Artist - Title.mp3")).toEqual({
      artist: "Artist",
      title: "Title",
    });
    expect(parseFilename("/x/Just_a_name.flac")).toEqual({ artist: null, title: "Just a name" });
    for (const n of [".x.mp3", "a.mp3.part", "b.crdownload", "~$c.mp3"])
      expect(isIgnoredName(n)).toBe(true);
    expect(isIgnoredName("ok.mp3")).toBe(false);
  });
});

describe("loudness (M2.4)", () => {
  it("measures a known tone within ±0.5 LU and stores the playback gain", async () => {
    const m = env.repos.media.findByRelativePath("General/Band B - Song B.mp3")!;
    const r = await analyzeMedia(env.repos, m.id, -16);
    // 0.1-amplitude 997 Hz stereo sine ≈ −20.0 LUFS (K-weighting adds ≈ +0.7 dB at 1 kHz).
    expect(Math.abs(r.lufs - -20)).toBeLessThanOrEqual(0.5);
    expect(r.peakDb).toBeLessThan(-18);
    const row = env.repos.media.get(m.id)!;
    expect(row.gain_db).toBeCloseTo(-16 - row.loudness_lufs!, 0);
    expect(gainFor(-40, -16)).toBe(12); // boost capped
    expect(gainFor(-2, -16)).toBe(-14);
  }, 30_000);

  it("works through the pending queue and ends even when files fail", async () => {
    let total = 0;
    for (let i = 0; i < 10; i += 1) {
      const n = await analyzePending(env.repos, -16, 3);
      total += n;
      if (n === 0) break;
    }
    expect(total).toBeGreaterThan(0);
    expect(env.repos.media.needsLoudness(100)).toHaveLength(0);
  }, 60_000);
});

describe("watch folder (M2.5)", () => {
  it("auto-imports a dropped file within 5 s", async () => {
    const imported: number[][] = [];
    const watcher = new MediaWatcher(env.repos, env.config, (ids) => imported.push(ids), 300);
    watcher.start();
    try {
      await new Promise((r) => setTimeout(r, 500));
      const t0 = Date.now();
      makeTone(join(env.config.media.watchFolder, "Dropped - In.mp3"), { seconds: 1 });
      while (imported.length === 0 && Date.now() - t0 < 5000)
        await new Promise((r) => setTimeout(r, 50));
      expect(Date.now() - t0).toBeLessThan(5000);
      const row = env.repos.media.get(imported[0]![0]!)!;
      expect(row).toMatchObject({ artist: "Dropped", title: "In", status: "ok" });
      expect(watcher.status).toMatchObject({
        imported: 1,
        watching: [env.config.media.watchFolder],
      });
    } finally {
      await watcher.stop();
    }
  }, 15_000);
});

describe("metadata lookup (M2.7)", () => {
  const mbResponse = {
    recordings: [
      {
        id: "rec-1",
        score: 100,
        title: "Song B (Remastered)",
        "artist-credit": [{ name: "Band B" }],
        "first-release-date": "1984-03-01",
        releases: [{ id: "rel-1", title: "Greatest", status: "Official" }],
      },
      { id: "rec-2", score: 20, title: "Nope", "artist-credit": [{ name: "X" }] },
    ],
  };

  it("parses recordings and drops low scores", () => {
    expect(parseRecordings(mbResponse)).toEqual([
      {
        artist: "Band B",
        title: "Song B (Remastered)",
        album: "Greatest",
        year: 1984,
        score: 100,
        mbid: "rec-1",
        releaseId: "rel-1",
      },
    ]);
  });

  it("queues a suggestion with a proper User-Agent and applies it", async () => {
    const m = env.repos.media.findByRelativePath("General/Band B - Song B.mp3")!;
    let seen: { url: string; ua: string | null } | null = null;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen = { url, ua: new Headers(init?.headers).get("user-agent") };
      return new Response(JSON.stringify(mbResponse), { status: 200 });
    }) as typeof fetch;
    expect(await suggestForMedia(env.repos, m.id, { fetchImpl, minIntervalMs: 0 })).toBe(1);
    expect(seen!.url).toContain("musicbrainz.org/ws/2/recording");
    expect(decodeURIComponent(seen!.url)).toContain('recording:"Song B" AND artist:"Band B"');
    expect(seen!.ua).toMatch(/online-radio-player/);
    // A second lookup does not queue the same recording twice.
    expect(await suggestForMedia(env.repos, m.id, { fetchImpl, minIntervalMs: 0 })).toBe(0);
    const s = env.repos.media.listSuggestions().find((x) => x.media_id === m.id)!;
    applySuggestion(env.repos, s.id);
    expect(env.repos.media.get(m.id)).toMatchObject({
      title: "Song B (Remastered)",
      album: "Greatest",
      year: 1984,
    });
    expect(env.repos.media.get(m.id)!.tags).toMatchObject({ edited: true, tagsMissing: false });
    expect(() => applySuggestion(env.repos, s.id)).toThrow(/applied/);
  });
});
