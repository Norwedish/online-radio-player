import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  createRepositories,
  openDatabase,
  runMigrations,
  seedDatabase,
  type Repositories,
} from "./index.js";
import { verifyPassword, hashPassword, randomToken, safeEqual, sha256 } from "./crypto.js";

let dir: string;
let db: Database.Database;
let repos: Repositories;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "radio-ops-"));
  runMigrations(join(dir, "radio.db"));
  db = openDatabase(join(dir, "radio.db"));
  await seedDatabase(db, {});
  repos = createRepositories(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const track = (n: number, artist = `Artist ${n}`) =>
  repos.media.upsert({
    path: `/lib/t${n}.mp3`,
    title: `Track ${n}`,
    artist,
    duration: 200,
    status: "ok",
  }).row.id;

describe("stations", () => {
  it("updates name, timezone and colors", () => {
    const s = repos.stations.update(1, { name: "Ops FM", colors: { tally: "#ffb020" } });
    expect(s?.name).toBe("Ops FM");
    expect(s?.colors).toEqual({ tally: "#ffb020" });
    expect(repos.stations.update(1, {})?.name).toBe("Ops FM");
    expect(repos.stations.get(999)).toBeUndefined();
  });
});

describe("alerts", () => {
  it("dedupes by open type, filters, acknowledges and resolves", () => {
    const a = repos.alerts.create({ type: "dead_air", severity: "critical", message: "silence" });
    repos.alerts.create({
      type: "disk",
      severity: "warning",
      message: "low",
      details: { free: 1 },
    });
    expect(repos.alerts.latestOpen("dead_air")?.id).toBe(a.id);
    expect(repos.alerts.countActive()).toBe(2);
    expect(repos.alerts.list({ severity: "warning" }).items).toHaveLength(1);
    expect(repos.alerts.acknowledge(a.id, null)).toBe(true);
    expect(repos.alerts.acknowledge(a.id, null)).toBe(false);
    expect(repos.alerts.list({ active: true }).total).toBe(1);
    expect(repos.alerts.resolveType("disk")).toBe(1);
    expect(repos.alerts.latestOpen("disk")).toBeUndefined();
    expect(repos.alerts.countActive()).toBe(0);
  });
});

describe("requests", () => {
  it("tracks IP windows, blacklist and status counts", () => {
    const id = track(1);
    const r = repos.requests.create({ ip: "1.1.1.1", title: "Track 1" });
    repos.requests.setMedia(r.id, id);
    repos.requests.markPlayed(r.id);
    expect(repos.requests.get(r.id)?.status).toBe("played");
    expect(repos.requests.lastFromIp("1.1.1.1")?.id).toBe(r.id);
    expect(repos.requests.countFromIpSince("1.1.1.1", "2000-01-01")).toBe(1);
    expect(repos.requests.countFromIpSince("2.2.2.2", "2000-01-01")).toBe(0);
    expect(repos.requests.hitRateLimit("1.1.1.1", "2026-01-01T10")).toBe(1);
    expect(repos.requests.hitRateLimit("1.1.1.1", "2026-01-01T10")).toBe(2);
    const b = repos.requests.addBlacklist("Baby Shark", "contains", null);
    expect(repos.requests.blacklist().map((x) => x.pattern)).toEqual(["Baby Shark"]);
    expect(repos.requests.removeBlacklist(b)).toBe(true);
    expect(repos.requests.removeBlacklist(b)).toBe(false);
    expect(repos.requests.countByStatus()).toEqual({ played: 1 });
  });
});

describe("events", () => {
  it("lists, updates, finds due events and protects active ones from deletion", () => {
    const e = repos.events.create({
      title: "Match",
      type: "live",
      startAt: "2026-01-01T10:00:00Z",
      endAt: "2026-01-01T12:00:00Z",
      priority: 5,
      createdBy: null,
    });
    const later = repos.events.create({
      title: "Later",
      type: "live",
      startAt: "2026-02-01T10:00:00Z",
      priority: 1,
      createdBy: null,
    });
    expect(repos.events.due("2026-01-01T11:00:00Z").map((x) => x.id)).toEqual([e.id]);
    expect(repos.events.due("2026-01-01T13:00:00Z")).toHaveLength(0);
    repos.events.update(e.id, { status: "active", title: "Match (live)" });
    expect(repos.events.active().map((x) => x.title)).toEqual(["Match (live)"]);
    expect(repos.events.list({ status: "scheduled" }).map((x) => x.id)).toEqual([later.id]);
    expect(repos.events.list({ from: "2026-01-15" }).map((x) => x.id)).toContain(later.id);
    expect(repos.events.delete(e.id)).toBe(false);
    expect(repos.events.delete(later.id)).toBe(true);
    expect(repos.events.update(e.id, {})?.id).toBe(e.id);
  });
});

describe("history and airplay", () => {
  it("records plays, ranges, counts, airplay stats and purges", () => {
    const a = track(1, "ABBA");
    const b = track(2, "Queen");
    const h1 = repos.history.start({
      mediaId: a,
      planId: null,
      startedAt: "2026-01-01T10:00:00Z",
      source: "automation",
    });
    repos.history.end(h1, "2026-01-01T10:03:20Z", 12);
    repos.history.start({
      mediaId: a,
      planId: null,
      startedAt: "2026-01-02T11:00:00Z",
      source: "request",
    });
    repos.history.start({
      mediaId: b,
      planId: null,
      startedAt: "2026-01-02T12:00:00Z",
      source: "automation",
    });
    repos.history.endLatestOpen(a, "2026-01-02T11:03:00Z");
    const recent = repos.history.recent(10, 0, "2026-01-02", "2026-01-03");
    expect(recent.map((r) => r.title)).toEqual(["Track 2", "Track 1"]);
    expect(recent[1]?.ended_at).toBe("2026-01-02T11:03:00Z");
    expect(repos.history.playCounts("2026-01-01").get(a)).toBe(2);
    expect(repos.history.playedSince("2026-01-02")).toHaveLength(2);
    const air = repos.history.airplay("2026-01-01", "2026-01-03");
    expect(air.totalPlays).toBe(3);
    expect(air.uniqueArtists).toBe(2);
    expect(air.topArtists[0]).toEqual({ artist: "ABBA", plays: 2 });
    expect(air.bySource).toEqual({ automation: 2, request: 1 });
    expect(air.perDay).toEqual([
      { day: "2026-01-01", plays: 1 },
      { day: "2026-01-02", plays: 2 },
    ]);
    expect(repos.history.purgeBefore("2026-01-02")).toBe(1);
  });
});

describe("listener stats", () => {
  it("buckets series, reports current and peak, purges", () => {
    repos.listeners.record("2026-01-01T10:00:10Z", [
      { mount: "hq.mp3", listeners: 10 },
      { mount: "aac.aac", listeners: 5 },
    ]);
    repos.listeners.record("2026-01-01T10:03:10Z", [{ mount: "hq.mp3", listeners: 20 }]);
    repos.listeners.record("2026-01-01T10:20:00Z", [{ mount: "hq.mp3", listeners: 7 }]);
    const series = repos.listeners.series("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", 5);
    expect(
      series.find((s) => s.ts === "2026-01-01T10:00:00Z" && s.mount === "hq.mp3")?.listeners,
    ).toBe(20);
    expect(repos.listeners.current()).toEqual([
      { mount: "hq.mp3", listeners: 7, ts: "2026-01-01T10:20:00Z" },
    ]);
    expect(repos.listeners.peak("2026-01-01")).toBe(20);
    expect(repos.listeners.peak("2027-01-01")).toBe(0);
    expect(repos.listeners.purgeBefore("2026-01-01T10:10:00Z")).toBe(3);
  });
});

describe("live sessions", () => {
  it("opens, ends, lists, reports shifts and expires recordings", async () => {
    const user = repos.users.create({
      username: "dj",
      email: "dj@example.org",
      role: "dj",
      passwordHash: await hashPassword("password-12345"),
    });
    const s = repos.live.start({ userId: user.id, mode: "duck", recordedPath: "/rec/a.flac" });
    expect(repos.live.open()?.id).toBe(s.id);
    const ended = repos.live.end(s.id, { recordedSize: 1000, peakListeners: 9 });
    expect(ended?.ended_at).toBeTruthy();
    expect(repos.live.open()).toBeUndefined();
    expect(repos.live.end(999, {})).toBeUndefined();
    expect(repos.live.list({ userId: user.id, since: "2000", until: "9999" })).toHaveLength(1);
    expect(repos.live.recordings()).toHaveLength(1);
    expect(repos.live.expiredRecordings("9999")).toHaveLength(1);
    const report = repos.live.shiftReport("2000", "9999");
    expect(report[0]).toMatchObject({ username: "dj", sessions: 1, peak_listeners: 9 });
    repos.live.clearRecording(s.id);
    expect(repos.live.recordings()).toHaveLength(0);
  });
});

describe("backups registry", () => {
  it("records, lists and forgets", () => {
    repos.backups.record("/b/1.sqlite3", "daily", 10, true);
    repos.backups.record("/b/2.sqlite3", "weekly", 20, false);
    expect(repos.backups.list().map((b) => b.path)).toEqual(["/b/2.sqlite3", "/b/1.sqlite3"]);
    expect(repos.backups.list()[1]?.verified_at).toBeTruthy();
    repos.backups.forget(["/b/1.sqlite3"]);
    expect(repos.backups.list()).toHaveLength(1);
  });
});

describe("crypto helpers", () => {
  it("hashes, verifies and compares in constant time", async () => {
    const h = await hashPassword("pw-123456789");
    expect(await verifyPassword(h, "pw-123456789")).toBe(true);
    expect(await verifyPassword(h, "nope")).toBe(false);
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
    expect(randomToken(16)).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(sha256("abc")).toHaveLength(64);
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
