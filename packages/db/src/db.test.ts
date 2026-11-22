import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupDatabase,
  createRepositories,
  hashPassword,
  listBackupFiles,
  openDatabase,
  restoreDatabase,
  rotateBackups,
  runMigrations,
  runRetention,
  seedDatabase,
  verifyPassword,
  type Database,
} from "./index.js";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "radio-db-"));
  runMigrations(join(dir, "radio.db"));
  db = openDatabase(join(dir, "radio.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("seed (M1.3)", () => {
  it("creates the station, 24 hour playlists, 24 slots and the bootstrap admin", async () => {
    const report = await seedDatabase(db, {
      admin: { username: "admin", password: "correct-horse-battery" },
    });
    const repos = createRepositories(db);
    expect(report.stationCreated).toBe(true);
    expect(repos.schedule.slots()).toHaveLength(24);
    const names = repos.playlists.list().map((p) => p.name);
    expect(names).toContain("[PM] 00:00");
    expect(names).toContain("[PM] 23:00");
    for (const n of ["00s", "90s", "General", "Nieuws", "Jingles", "Emergency"])
      expect(names).toContain(n);
    const admin = repos.users.findByLogin("admin")!;
    expect(admin.role).toBe("admin");
    expect(admin.is_active).toBe(true);
    expect(await verifyPassword(admin.password_hash, "correct-horse-battery")).toBe(true);
    expect(await verifyPassword(admin.password_hash, "wrong")).toBe(false);
    expect(repos.schedule.getSetting("template.base", [] as unknown[])).toHaveLength(4);
  });

  it("is idempotent", async () => {
    await seedDatabase(db, { admin: { username: "admin", password: "correct-horse-battery" } });
    const again = await seedDatabase(db, {
      admin: { username: "admin", password: "correct-horse-battery" },
    });
    expect(again).toMatchObject({
      stationCreated: false,
      playlistsCreated: 0,
      slotsCreated: 0,
      adminCreated: false,
    });
    expect(createRepositories(db).schedule.slots()).toHaveLength(24);
  });
});

describe("schema constraints", () => {
  beforeEach(async () => {
    await seedDatabase(db);
  });

  it("rejects an invalid role", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO users (station_id, username, email, password_hash, role, created_at, updated_at) VALUES (1, 'x', 'x@x', 'h', 'root', '', '')",
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("rejects a schedule slot hour outside 0-23", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO schedule_slots (station_id, hour, playlist_id, days_json, start_date, created_at, updated_at) VALUES (1, 24, 1, '[]', '2030-01-01', '', '')",
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("enforces foreign keys", () => {
    expect(() =>
      db.prepare("INSERT INTO playlist_items (playlist_id, media_id) VALUES (9999, 9999)").run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it("keeps the audit log append-only at the repository level", () => {
    const repos = createRepositories(db);
    const audit = repos.audit as unknown as Record<string, unknown>;
    expect(audit.update).toBeUndefined();
    expect(audit.delete).toBeUndefined();
  });
});

describe("repositories (M1.4)", () => {
  beforeEach(async () => {
    await seedDatabase(db);
  });

  it("upserts media by path and searches with filters", () => {
    const repos = createRepositories(db);
    const a = repos.media.upsert({
      path: "/m/a.mp3",
      title: "Song A",
      artist: "Alpha",
      duration: 200,
      hash: "h1",
    });
    expect(a.created).toBe(true);
    const again = repos.media.upsert({ path: "/m/a.mp3", title: "Song A (edit)" });
    expect(again.created).toBe(false);
    expect(again.row.title).toBe("Song A (edit)");
    repos.media.upsert({
      path: "/m/b.mp3",
      title: "Song B",
      artist: "Beta",
      duration: 100,
      hash: "h1",
    });
    repos.media.upsert({ path: "/m/c.mp3", title: "Other", artist: "Alpha", duration: 300 });
    expect(repos.media.search({ artist: "alpha" }).total).toBe(2);
    expect(repos.media.search({ maxDuration: 150 }).items.map((m) => m.title)).toEqual(["Song B"]);
    expect(repos.media.search({ duplicates: true }).total).toBe(2);
    expect(repos.media.duplicateGroups().some((g) => g.kind === "hash")).toBe(true);
  });

  it("uses parameterized queries (no injection through search)", () => {
    const repos = createRepositories(db);
    repos.media.upsert({ path: "/m/x.mp3", title: "x" });
    expect(() => repos.media.search({ q: "'; DROP TABLE media; --" })).not.toThrow();
    expect(repos.media.count()).toBe(1);
  });

  it("round-trips a plan with items in order", () => {
    const repos = createRepositories(db);
    const m = repos.media.upsert({ path: "/m/a.mp3", title: "A", artist: "X", duration: 180 }).row;
    const plan = repos.schedule.savePlan({
      date: "2030-01-01",
      hour: 5,
      status: "ready",
      totalSeconds: 3600,
      warnings: ["w"],
      snapshot: { v: 1 },
      items: [
        {
          mediaId: null,
          kind: "news",
          startSeconds: 0,
          length: 180,
          playlistId: null,
          artist: null,
          title: "News",
          locked: true,
        },
        {
          mediaId: m.id,
          kind: "music",
          startSeconds: 180,
          length: 180,
          playlistId: null,
          artist: "X",
          title: "A",
          locked: false,
        },
      ],
    });
    const items = repos.schedule.items(plan.id);
    expect(items.map((i) => i.kind)).toEqual(["news", "music"]);
    expect(items[0]!.is_locked).toBe(true);
    expect(repos.schedule.plan("2030-01-01", 5)!.warnings).toEqual(["w"]);
    // Replacing keeps one plan row.
    repos.schedule.savePlan({
      date: "2030-01-01",
      hour: 5,
      status: "ready",
      totalSeconds: 1,
      warnings: [],
      snapshot: null,
      items: [],
    });
    expect(repos.schedule.plansForDate("2030-01-01")).toHaveLength(1);
    expect(repos.schedule.items(plan.id)).toHaveLength(0);
  });

  it("manages sessions, API keys and password resets", async () => {
    const repos = createRepositories(db);
    const user = repos.users.create({
      username: "dj1",
      email: "dj1@x.io",
      role: "dj",
      passwordHash: await hashPassword("x".repeat(12)),
    });
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const s = repos.sessions.create({
      userId: user.id,
      tokenHash: "t1",
      ip: "1.1.1.1",
      userAgent: null,
      expiresAt: future,
    });
    expect(repos.sessions.findActive("t1")?.id).toBe(s.id);
    repos.sessions.revoke(s.id);
    expect(repos.sessions.findActive("t1")).toBeUndefined();
    const key = repos.apiKeys.create({
      name: "k",
      prefix: "rk_abc",
      keyHash: "kh",
      scopes: ["read"],
      createdBy: user.id,
    });
    expect(repos.apiKeys.findActive("kh")?.scopes).toEqual(["read"]);
    repos.apiKeys.revoke(key.id);
    expect(repos.apiKeys.findActive("kh")).toBeUndefined();
    repos.passwordResets.create(user.id, "r1", future);
    expect(repos.passwordResets.consume("r1")).toBe(user.id);
    expect(repos.passwordResets.consume("r1")).toBeUndefined();
  });

  it("counts request rate-limit windows and blacklist entries", () => {
    const repos = createRepositories(db);
    expect(repos.requests.hitRateLimit("9.9.9.9", "2030-01-01T10")).toBe(1);
    expect(repos.requests.hitRateLimit("9.9.9.9", "2030-01-01T10")).toBe(2);
    repos.requests.addBlacklist("badword", "contains", null);
    expect(repos.requests.blacklist()).toHaveLength(1);
  });
});

describe("backup/restore (M1.6)", () => {
  it("round-trips users and plans", async () => {
    await seedDatabase(db, { admin: { username: "admin", password: "correct-horse-battery" } });
    const repos = createRepositories(db);
    repos.schedule.savePlan({
      date: "2030-02-02",
      hour: 1,
      status: "ready",
      totalSeconds: 3600,
      warnings: [],
      snapshot: null,
      items: [],
    });
    const result = await backupDatabase(db, join(dir, "backups"));
    expect(result.integrity).toBe("ok");
    expect(existsSync(result.path)).toBe(true);

    // Damage the live DB, then restore.
    db.prepare("DELETE FROM hourly_plans").run();
    db.close();
    const restored = restoreDatabase(result.path, join(dir, "radio.db"));
    expect(restored.users).toBe(1);
    expect(restored.plans).toBe(1);
    db = openDatabase(join(dir, "radio.db"));
    expect(createRepositories(db).schedule.plan("2030-02-02", 1)).toBeDefined();
  });

  it("rotates daily and weekly backups", async () => {
    await seedDatabase(db);
    const target = join(dir, "rot");
    for (let d = 1; d <= 20; d += 1) {
      await backupDatabase(db, target, {
        now: new Date(Date.UTC(2030, 0, d, 3)),
        dailyKeep: 14,
        weeklyKeep: 8,
      });
    }
    const files = listBackupFiles(target);
    expect(files.daily).toHaveLength(14);
    expect(files.weekly.length).toBeLessThanOrEqual(8);
    expect(rotateBackups(target, { dailyKeep: 2, weeklyKeep: 1 }).length).toBeGreaterThan(0);
    expect(listBackupFiles(target).daily).toHaveLength(2);
  });
});

describe("retention (M12.5)", () => {
  it("deletes old rows and keeps recent ones", async () => {
    await seedDatabase(db);
    const repos = createRepositories(db);
    const m = repos.media.upsert({ path: "/m/a.mp3", title: "A", duration: 10 }).row;
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    const recent = new Date().toISOString();
    repos.history.start({ mediaId: m.id, planId: null, startedAt: old, source: "automation" });
    repos.history.start({ mediaId: m.id, planId: null, startedAt: recent, source: "automation" });
    repos.listeners.record(old, [{ mount: "hq.mp3", listeners: 3 }]);
    repos.listeners.record(recent, [{ mount: "hq.mp3", listeners: 5 }]);
    const report = runRetention(db, { historyDays: 90, requestsDays: 30, logsDays: 30 });
    expect(report.playHistory).toBe(1);
    expect(report.listenerStats).toBe(1);
    expect(repos.history.recent(10)).toHaveLength(1);
  });
});
