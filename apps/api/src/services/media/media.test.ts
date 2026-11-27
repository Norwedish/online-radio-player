import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, makeTone, type TestEnv } from "../../test-utils.js";
import { analyzeMedia, analyzePending, gainFor, recomputeAutocue } from "./loudness.js";
import { applySuggestion, parseRecordings, suggestForMedia } from "./metadata-lookup.js";
import { NewsRefresher } from "./news-refresh.js";
import { parseFilename } from "./probe.js";
import { importFile, isIgnoredName, scanLibrary, type MediaRoot } from "./scanner.js";
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

  it("does not mark tracks missing when a share is unmounted (folder looks empty)", async () => {
    const share = join(root, "..", "share-mount");
    const file = makeTone(join(share, "Sharer - Song.mp3"), { seconds: 1 });
    const roots: MediaRoot[] = [{ id: "share", path: share }];
    const row = () => env.repos.media.search({ artist: "Sharer" }).items[0];
    await scanLibrary(env.repos, env.config, { roots });
    expect(row()?.status).toBe("ok");
    rmSync(file); // the share "drops out": the mount point is still there but empty
    const report = await scanLibrary(env.repos, env.config, { roots });
    expect(report.missing).toBe(0);
    expect(report.errors.join()).toMatch(/is the share mounted/);
    expect(row()?.status).toBe("ok");
    // Clean up so the later rescan counts stay as before.
    env.repos.media.delete(row()!.id);
    rmSync(share, { recursive: true, force: true });
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
  /** Tone with leading silence and an optional linear fade-out (for autocue tests). */
  function makeFadeTone(
    path: string,
    opts: { lead: number; body: number; fade: number; tail: number },
  ) {
    const { lead, body, fade, tail } = opts;
    const end = lead + body;
    const fadeStart = end - fade;
    const shape = fade > 0 ? `if(lt(t\\,${fadeStart})\\,1\\,max(0\\,(${end}-t)/${fade}))` : "1";
    const expr = `if(between(t\\,${lead}\\,${end})\\,0.1*sin(2*PI*440*t)*${shape}\\,0)`;
    mkdirSync(dirname(path), { recursive: true });
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `aevalsrc=${expr}|${expr}:s=48000:d=${end + tail}`,
      "-c:a",
      "pcm_s16le",
      path,
    ]);
    return path;
  }

  it("detects cue points and the crossfade from volume (autocue)", async () => {
    const path = makeFadeTone(join(root, "General", "Autocue - Fade.wav"), {
      lead: 1.5,
      body: 8,
      fade: 3,
      tail: 1.5,
    });
    const { row } = await importFile(env.repos, env.config, path);
    const m = row!;
    const r = await analyzeMedia(env.repos, m.id, -16);
    expect(r.autocue).not.toBeNull();
    const got = env.repos.media.get(m.id)!;
    expect(got.cue_source).toBe("auto");
    expect(got.loudness_envelope).toBeTruthy();
    // Leading silence is trimmed (1.5 s minus the 0.1 + 0.2 s safety margin).
    expect(got.cue_in!).toBeGreaterThan(1.1);
    expect(got.cue_in!).toBeLessThan(1.6);
    expect(got.fade_in).toBeCloseTo(0.2, 1);
    // A 3 s fade to silence: cue-out near its end, crossfade where it passes −7 dB.
    expect(got.cue_out!).toBeGreaterThan(9.2);
    expect(got.cue_out!).toBeLessThan(10.05);
    expect(got.fade_out!).toBeGreaterThan(0.8);
    expect(got.fade_out!).toBeLessThan(2.2);
    const cross = got.cue_out! - got.fade_out!;
    expect(cross).toBeGreaterThan(7.8);
    expect(cross).toBeLessThan(9.2);
    expect(JSON.parse(got.autocue_json!)).toMatchObject({ sustained: expect.any(Boolean) });
  }, 30_000);

  it("re-analyses a replaced news file once it is completely written", async () => {
    const rel = "Nieuws/test-news.wav";
    const path = join(root, rel);
    const refresher = new NewsRefresher(
      env.repos,
      env.config,
      () => [rel],
      () => -16,
    );
    makeTone(path, { seconds: 2, format: "wav" });
    expect(await refresher.check()).toBe(0); // first look: wait for the file to settle
    expect(await refresher.check()).toBe(1);
    const first = env.repos.media.getByPath(path)!;
    expect(first.loudness_envelope).toBeTruthy();
    expect(first.cue_out!).toBeLessThanOrEqual(2.05);
    expect(await refresher.check()).toBe(0); // unchanged: nothing to do
    // The next bulletin arrives under the same name, twice as long.
    makeTone(path, { seconds: 4, format: "wav" });
    expect(await refresher.check()).toBe(0);
    expect(await refresher.check()).toBe(1);
    const second = env.repos.media.getByPath(path)!;
    expect(second.id).toBe(first.id);
    expect(second.duration!).toBeGreaterThan(3.9);
    expect(second.cue_out!).toBeGreaterThan(3.8);
    env.repos.media.delete(second.id);
    rmSync(path);
  }, 30_000);

  /** Config with one enabled NAS path (the SMB share) next to media.root. */
  const withNas = () => {
    const mount = join(env.dir, "nas-mount");
    const config = {
      ...env.config,
      media: {
        ...env.config.media,
        nasPaths: [
          { id: "off", mountPath: join(env.dir, "nas-off"), relativePath: "/", enabled: false },
          { id: "share", mountPath: mount, relativePath: "/radio-music", enabled: true },
        ],
      },
    };
    return { config, nasRoot: join(mount, "radio-music") };
  };

  it("picks up a news file that only exists on a NAS path, ignoring the .tmp beside it", async () => {
    const { config, nasRoot } = withNas();
    const rel = "Nieuws/nas-news.wav";
    const path = join(nasRoot, rel);
    const tmp = join(nasRoot, "Nieuws", ".nas-news.wav.tmp");
    const logs: string[] = [];
    const refresher = new NewsRefresher(
      env.repos,
      config,
      () => [rel],
      () => -16,
      (m) => logs.push(m),
    );
    expect(await refresher.check()).toBe(0); // not there yet: nothing happens
    makeTone(path, { seconds: 2, format: "wav" });
    expect(await refresher.check()).toBe(0);
    expect(await refresher.check()).toBe(1);
    const first = env.repos.media.getByPath(path)!;
    expect(first.relative_path).toBe(rel);
    expect(first.duration!).toBeLessThan(2.1);

    // The generator writes ".nas-news.wav.tmp" first, then renames it over the bulletin.
    const staging = makeTone(join(env.dir, "staging", "next.wav"), { seconds: 4, format: "wav" });
    copyFileSync(staging, tmp);
    expect(await refresher.check()).toBe(0);
    expect(await refresher.check()).toBe(0); // the .tmp is not the bulletin
    expect(env.repos.media.getByPath(tmp)).toBeUndefined();
    renameSync(tmp, path);
    expect(await refresher.check()).toBe(0); // first look at the new version
    expect(await refresher.check()).toBe(1); // second tick: re-imported, no full scan
    const second = env.repos.media.getByPath(path)!;
    expect(second.id).toBe(first.id);
    expect(second.duration!).toBeGreaterThan(3.9);
    expect(second.loudness_envelope).toBeTruthy();
    expect(logs.some((l) => l.includes("warning"))).toBe(false);
    env.repos.media.delete(second.id);
    rmSync(path);
  }, 30_000);

  it("prefers media.root when a news file exists there and on a NAS path, warning once", async () => {
    const { config, nasRoot } = withNas();
    const rel = "Nieuws/both-news.wav";
    const local = makeTone(join(root, rel), { seconds: 2, format: "wav" });
    const nas = makeTone(join(nasRoot, rel), { seconds: 3, format: "wav" });
    const logs: string[] = [];
    const refresher = new NewsRefresher(
      env.repos,
      config,
      () => [rel],
      () => -16,
      (m) => logs.push(m),
    );
    expect(await refresher.check()).toBe(0);
    expect(await refresher.check()).toBe(1);
    expect(await refresher.check()).toBe(0);
    expect(env.repos.media.getByPath(local)).toBeTruthy();
    expect(env.repos.media.getByPath(nas)).toBeUndefined();
    expect(logs.filter((l) => l.includes("warning") && l.includes(rel))).toHaveLength(1);
    env.repos.media.delete(env.repos.media.getByPath(local)!.id);
    rmSync(local);
    rmSync(nas);
  }, 30_000);

  it("respects manual cue points until they are adopted again", async () => {
    const m = env.repos.media.findByRelativePath("General/Autocue - Fade.wav")!;
    env.repos.media.update(m.id, { cue_in: 5, cue_source: "manual" });
    recomputeAutocue(env.repos, m.id);
    expect(env.repos.media.get(m.id)!.cue_in).toBe(5);
    expect(env.repos.media.get(m.id)!.cue_source).toBe("manual");
    recomputeAutocue(env.repos, m.id, {}, true);
    const adopted = env.repos.media.get(m.id)!;
    expect(adopted.cue_source).toBe("auto");
    expect(adopted.cue_in!).toBeGreaterThan(1.1);
  });

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
