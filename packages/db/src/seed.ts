/**
 * Seed (PLAN M1.3): default station, 24 `[PM] HH:00` playlists + schedule
 * slots, decade playlists, General, Nieuws, Jingles, Emergency placeholder,
 * default schedule settings/template and the bootstrap admin. Idempotent.
 */
import type Database from "better-sqlite3";
import {
  DECADE_PLAYLISTS,
  DEFAULT_TEMPLATE,
  EMERGENCY_PLAYLIST,
  GENERAL_PLAYLIST,
  GENERATOR_SETTINGS_DEFAULTS,
  JINGLES_PLAYLIST,
  NEWS_PLAYLIST,
  SCHEDULE_KEYS,
  hourPlaylistName,
} from "@radio/shared";
import { hashPassword } from "./crypto.js";
import { createRepositories } from "./repos/index.js";
import { nowIso, toJson } from "./util.js";

export interface SeedOptions {
  stationName?: string;
  timezone?: string;
  locale?: string;
  /** First date the 24 schedule slots apply (YYYY-MM-DD). Defaults to 2020-01-01. */
  slotStartDate?: string;
  admin?: { username: string; email?: string; password: string } | null;
  /** Default runtime settings to store under `settings` (e.g. from station.json). */
  settings?: Record<string, unknown>;
}

export interface SeedReport {
  stationCreated: boolean;
  playlistsCreated: number;
  slotsCreated: number;
  settingsCreated: number;
  adminCreated: boolean;
  adminUsername: string | null;
}

export const DEFAULT_RUNTIME_SETTINGS: Record<string, unknown> = {
  "audio.masterGain": 1,
  "audio.boundaryToleranceSeconds": 45,
  "audio.silenceThresholdDb": -60,
  "audio.silenceSeconds": 10,
  "audio.targetLufs": -16,
  "audio.autocue.enabled": true,
  "audio.autocue.cueInThreshold": -34,
  "audio.autocue.cueOutThreshold": -42,
  "audio.autocue.crossThreshold": -7,
  "audio.autocue.maxOverlap": 6,
  "audio.autocue.sustainedEndings": true,
  "live.duckDb": -12,
  "live.duckAttackMs": 50,
  "live.duckReleaseMs": 500,
  "live.noShowGraceSeconds": 120,
  "requests.enabled": true,
  "requests.autoApprove": false,
  "requests.cooldownMinutes": 60,
  "requests.maxPerHour": 3,
  "requests.profanityFilter": true,
  "requests.dedications": true,
  "retention.historyDays": 90,
  "retention.logsDays": 30,
  "retention.requestsDays": 30,
  "retention.recordingsDays": 30,
  "backups.dailyKeep": 14,
  "backups.weeklyKeep": 8,
  "alerts.emailTo": [],
  "alerts.dedupeSeconds": 300,
};

export async function seedDatabase(
  db: Database.Database,
  options: SeedOptions = {},
): Promise<SeedReport> {
  const repos = createRepositories(db, 1);
  const report: SeedReport = {
    stationCreated: false,
    playlistsCreated: 0,
    slotsCreated: 0,
    settingsCreated: 0,
    adminCreated: false,
    adminUsername: null,
  };
  const now = nowIso();
  const passwordHash = options.admin ? await hashPassword(options.admin.password) : null;

  const tx = db.transaction(() => {
    if (!repos.stations.get(1)) {
      db.prepare(
        "INSERT INTO stations (id, name, timezone, locale, logo_url, colors_json, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        options.stationName ?? "My Radio Station",
        options.timezone ?? "Europe/Amsterdam",
        options.locale ?? "en",
        null,
        toJson({ primary: "#22c55e", background: "#0b0f0e" }),
        now,
        now,
      );
      report.stationCreated = true;
    }

    const ensurePlaylist = (
      name: string,
      role: "music" | "news" | "jingle" | "general" | "decade",
      sortOrder: number,
      extra: { prefix?: string; enabled?: boolean; isJingle?: boolean } = {},
    ) => {
      const existing = repos.playlists.getByName(name);
      if (existing) return existing;
      report.playlistsCreated += 1;
      return repos.playlists.create({
        name,
        role,
        sortOrder,
        prefix: extra.prefix ?? null,
        enabled: extra.enabled ?? true,
        isJingle: extra.isJingle ?? false,
      });
    };

    const prefix = GENERATOR_SETTINGS_DEFAULTS.prefix;
    const hourPlaylists = Array.from({ length: 24 }, (_, hour) =>
      ensurePlaylist(hourPlaylistName(hour, prefix), "music", hour, { prefix }),
    );
    DECADE_PLAYLISTS.forEach((name, i) => ensurePlaylist(name, "decade", 100 + i));
    ensurePlaylist(GENERAL_PLAYLIST, "general", 200);
    ensurePlaylist(NEWS_PLAYLIST, "news", 300);
    ensurePlaylist(JINGLES_PLAYLIST, "jingle", 400, { isJingle: true });
    ensurePlaylist(EMERGENCY_PLAYLIST, "general", 900, { enabled: false });

    const startDate = options.slotStartDate ?? "2020-01-01";
    const existingHours = new Set(repos.schedule.slots().map((s) => s.hour));
    hourPlaylists.forEach((playlist, hour) => {
      if (existingHours.has(hour)) return;
      repos.schedule.createSlot({ hour, playlistId: playlist.id, startDate });
      report.slotsCreated += 1;
    });

    const scheduleDefaults: Record<string, unknown> = {
      [SCHEDULE_KEYS.generator]: GENERATOR_SETTINGS_DEFAULTS,
      [SCHEDULE_KEYS.templateBase]: DEFAULT_TEMPLATE,
      [SCHEDULE_KEYS.templateOverrides]: {},
      [SCHEDULE_KEYS.fallbackMode]: false,
    };
    for (const [key, value] of Object.entries(scheduleDefaults)) {
      const sentinel = Symbol("missing");
      if (repos.schedule.getSetting<unknown>(key, sentinel) === sentinel) {
        repos.schedule.setSetting(key, value);
        report.settingsCreated += 1;
      }
    }

    const runtime = { ...DEFAULT_RUNTIME_SETTINGS, ...(options.settings ?? {}) };
    for (const [key, value] of Object.entries(runtime)) {
      if (!repos.settings.has(key)) {
        repos.settings.set(key, value);
        report.settingsCreated += 1;
      }
    }

    if (options.admin && passwordHash) {
      report.adminUsername = options.admin.username;
      if (!repos.users.findByLogin(options.admin.username)) {
        repos.users.create({
          username: options.admin.username,
          email: options.admin.email ?? `${options.admin.username}@localhost.localdomain`,
          passwordHash,
          role: "admin",
          isActive: true,
        });
        report.adminCreated = true;
      }
    }
  });
  tx();
  return report;
}
