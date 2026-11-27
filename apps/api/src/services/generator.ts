/**
 * Generator service (PLAN M3.4–M3.7): resolves station time, applies guards,
 * builds candidate pools from the hour playlist (or decades + General in
 * fallback mode), seeds separation from recent plans and airplay, persists
 * plans, and logs `generator_runs`. Also hosts the 23:00 / 00:05 triggers,
 * the 5-minute news reprocess and the 5-minute integrity check.
 */
import {
  addDays,
  generateHour,
  generationGuard,
  hourStartMs,
  isoWeekday,
  minuteOfDay,
  parseHHMM,
  SeparationTracker,
  stationNow,
  type Candidate,
  type GeneratedItem,
} from "@radio/core";
import type { MediaRow, Repositories } from "@radio/db";
import {
  DECADE_PLAYLISTS,
  DEFAULT_TEMPLATE,
  GENERAL_PLAYLIST,
  GENERATOR_SETTINGS_DEFAULTS,
  JINGLES_PLAYLIST,
  SCHEDULE_KEYS,
  generatorSettingsSchema,
  hourPlaylistName,
  templateOverridesSchema,
  type GeneratorSettings,
  type RuntimeConfig,
  type TemplateBlock,
  type TemplateOverrides,
} from "@radio/shared";
import { probeFile } from "./media/probe.js";

export interface PlanPreview {
  date: string;
  hour: number;
  status: "ready" | "draft";
  skipped: string | null;
  totalSeconds: number;
  warnings: string[];
  items: GeneratedItem[];
  planId: number | null;
}

export interface GenerateRequest {
  date?: string;
  hours?: number[];
  dryRun?: boolean;
  /** Bypass the past guard (never the on-air guard). */
  force?: boolean;
  runType?: string;
  nowMs?: number;
}

export type AlertSink = (alert: {
  type: string;
  severity: "info" | "warning" | "error" | "critical";
  message: string;
  details?: Record<string, unknown>;
}) => void;

export function effectiveDuration(m: Pick<MediaRow, "duration" | "cue_in" | "cue_out">): number {
  const duration = m.duration ?? 0;
  const end = m.cue_out && m.cue_out > 0 ? Math.min(m.cue_out, duration) : duration;
  return Math.max(0, end - (m.cue_in ?? 0));
}

export class GeneratorService {
  constructor(
    private readonly repos: Repositories,
    private readonly config: RuntimeConfig,
    private readonly alert: AlertSink = () => {},
    private readonly onPlansChanged: (changes: { date: string; hour: number }[]) => void = () => {},
  ) {}

  get tz(): string {
    return this.repos.stations.get(this.repos.stationId)?.timezone ?? this.config.station.timezone;
  }

  settings(): GeneratorSettings {
    const stored = this.repos.schedule.getSetting<Partial<GeneratorSettings>>(
      SCHEDULE_KEYS.generator,
      {},
    );
    const parsed = generatorSettingsSchema.safeParse({ ...GENERATOR_SETTINGS_DEFAULTS, ...stored });
    const s = parsed.success ? parsed.data : GENERATOR_SETTINGS_DEFAULTS;
    return { ...s, fallback_mode: this.fallbackMode() };
  }

  fallbackMode(): boolean {
    return this.repos.schedule.getSetting<boolean>(SCHEDULE_KEYS.fallbackMode, false);
  }

  setFallbackMode(enabled: boolean): void {
    this.repos.schedule.setSetting(SCHEDULE_KEYS.fallbackMode, enabled);
  }

  template(): TemplateBlock[] {
    return this.repos.schedule.getSetting<TemplateBlock[]>(
      SCHEDULE_KEYS.templateBase,
      DEFAULT_TEMPLATE,
    );
  }

  overrides(): TemplateOverrides {
    const raw = this.repos.schedule.getSetting<unknown>(SCHEDULE_KEYS.templateOverrides, {});
    const parsed = templateOverridesSchema.safeParse(raw);
    return parsed.success ? parsed.data : {};
  }

  setOverride(
    hour: number,
    override: TemplateOverrides[string] | null,
    date?: string,
  ): TemplateOverrides {
    const all = this.overrides();
    const key = date ? `${date}:${hour}` : String(hour);
    if (override === null || Object.keys(override).length === 0) delete all[key];
    else all[key] = override;
    this.repos.schedule.setSetting(SCHEDULE_KEYS.templateOverrides, all);
    return all;
  }

  overrideFor(date: string, hour: number): TemplateOverrides[string] {
    const all = this.overrides();
    return { ...(all[String(hour)] ?? {}), ...(all[`${date}:${hour}`] ?? {}) };
  }

  private toCandidate(
    m: MediaRow,
    playlistId: number | null,
    weight: number,
    plays: Map<number, number>,
  ): Candidate {
    return {
      mediaId: m.id,
      artist: m.artist,
      title: m.title,
      duration: effectiveDuration(m),
      playlistId,
      weight,
      playCount: plays.get(m.id) ?? 0,
    };
  }

  private newsCandidate(relative: string): Candidate | null {
    const m = this.repos.media.findByRelativePath(relative.replace(/^\//, ""));
    if (!m || m.status !== "ok" || !m.duration) return null;
    const pl = this.repos.playlists.getByName("Nieuws");
    return {
      mediaId: m.id,
      artist: m.artist,
      title: m.title ?? "News",
      duration: effectiveDuration(m),
      playlistId: pl?.id ?? null,
      weight: 1,
      playCount: 0,
    };
  }

  /** Candidate pool for one hour (M3.3 + fallback mode). */
  pool(
    date: string,
    hour: number,
    settings: GeneratorSettings,
    plays: Map<number, number>,
  ): {
    music: Candidate[];
    jingles: Candidate[];
    byPlaylistName: Record<string, Candidate[]>;
    source: string[];
  } {
    const override = this.overrideFor(date, hour);
    const playlists = this.repos.playlists.list();
    const byName = new Map(playlists.map((p) => [p.name, p]));
    let names: string[];
    if (settings.fallback_mode) names = [...DECADE_PLAYLISTS, GENERAL_PLAYLIST];
    else {
      const slot = this.repos.schedule.slotFor(date, hour, isoWeekday(date));
      names = [
        override.playlistName ?? slot?.playlist_name ?? hourPlaylistName(hour, settings.prefix),
      ];
    }
    const ids = names
      .map((n) => byName.get(n))
      .filter((p) => p && p.enabled)
      .map((p) => p!.id);
    const rows = this.repos.playlists.pool(ids);
    // Playlist weight works like AzuraCast's: it sets how often that *playlist* gets a turn,
    // whatever its size (80s at weight 9 vs 10s at weight 20 ≈ 9:20 of the picks). Each song
    // gets weight/size of its playlist, scaled so a single-playlist pool is unchanged.
    const sizes = new Map<number, number>();
    for (const e of rows) sizes.set(e.playlistId, (sizes.get(e.playlistId) ?? 0) + 1);
    const plWeight = (id: number) => Math.max(0, playlists.find((p) => p.id === id)?.weight ?? 1);
    const totalWeight = [...sizes.keys()].reduce((sum, id) => sum + plWeight(id), 0);
    const music = rows.map((e) =>
      this.toCandidate(
        e.media,
        e.playlistId,
        totalWeight > 0
          ? (e.weight * plWeight(e.playlistId) * rows.length) /
              (sizes.get(e.playlistId)! * totalWeight)
          : e.weight,
        plays,
      ),
    );
    // Empty hour playlist → fall back to General so the station never runs dry.
    let source = names;
    if (music.length === 0 && !settings.fallback_mode) {
      const general = byName.get(GENERAL_PLAYLIST);
      if (general) {
        music.push(
          ...this.repos.playlists
            .pool([general.id])
            .map((e) => this.toCandidate(e.media, e.playlistId, e.weight, plays)),
        );
        source = [...names, `${GENERAL_PLAYLIST} (fallback)`];
      }
    }
    const jingle = byName.get(JINGLES_PLAYLIST);
    const jingles = jingle
      ? this.repos.playlists
          .pool([jingle.id])
          .map((e) => this.toCandidate(e.media, e.playlistId, e.weight, plays))
      : [];
    const byPlaylistName: Record<string, Candidate[]> = {};
    const blockNames = new Set(
      (override.blocks ?? this.template()).flatMap((b) => b.playlists ?? []),
    );
    for (const n of blockNames) {
      const p = byName.get(n);
      if (p)
        byPlaylistName[n] = this.repos.playlists
          .pool([p.id])
          .map((e) => this.toCandidate(e.media, e.playlistId, e.weight, plays));
    }
    // Dedupe by media id (a track may sit in several decade playlists).
    const seen = new Set<number>();
    return {
      music: music.filter((c) => (seen.has(c.mediaId) ? false : (seen.add(c.mediaId), true))),
      jingles,
      byPlaylistName,
      source,
    };
  }

  /** Separation seeded from what aired and what is planned around the target hours. */
  private separation(
    settings: GeneratorSettings,
    date: string,
    exclude: Set<string>,
  ): SeparationTracker {
    const tz = this.tz;
    const sep = new SeparationTracker(
      settings.separation_track_hours,
      settings.separation_artist_hours,
    );
    const from = addDays(date, -1);
    const since = new Date(Date.now() - 2 * 86_400_000).toISOString();
    for (const h of this.repos.history.playedSince(since))
      sep.add(h.media_id, h.artist, Date.parse(h.started_at));
    for (const p of this.repos.schedule.plannedSince(from)) {
      if (exclude.has(`${p.plan_date}:${p.hour}`)) continue;
      const start = hourStartMs(p.plan_date, p.hour, tz);
      if (start !== null) sep.add(p.media_id, p.artist, start + p.start_seconds * 1000);
    }
    return sep;
  }

  /** Default targets: the rest of today (future hours) or explicit hours. */
  generate(req: GenerateRequest = {}): { runId: number | null; plans: PlanPreview[] } {
    const nowMs = req.nowMs ?? Date.now();
    const tz = this.tz;
    const now = stationNow(tz, nowMs);
    const date = req.date ?? now.date;
    const hours = req.hours ?? Array.from({ length: 24 }, (_, h) => h);
    const settings = this.settings();
    const mode = settings.fallback_mode ? "fallback" : "normal";
    const runId = req.dryRun
      ? null
      : this.repos.schedule.startRun(
          req.runType ?? "manual",
          mode,
          { date, hours },
          new Date(nowMs).toISOString(),
        );
    const plays = this.repos.history.playCounts(new Date(nowMs - 7 * 86_400_000).toISOString());
    const sep = this.separation(settings, date, new Set(hours.map((h) => `${date}:${h}`)));
    const plans: PlanPreview[] = [];
    const warnings: string[] = [];
    const changed: { date: string; hour: number }[] = [];
    try {
      for (const hour of [...hours].sort((a, b) => a - b)) {
        const guard = generationGuard(date, hour, tz, nowMs);
        const override = this.overrideFor(date, hour);
        let skipped: string | null = null;
        if (guard === "on_air") skipped = "on-air hour is never rewritten";
        else if (guard === "past" && !req.force) skipped = "hour already passed";
        else if (guard === "nonexistent") skipped = "hour does not exist (DST)";
        else if (override.disabled) skipped = "hour disabled";
        else if (override.live) skipped = "live hour";
        else if (override.locked && this.repos.schedule.plan(date, hour)) skipped = "plan locked";
        if (skipped) {
          plans.push({
            date,
            hour,
            status: "draft",
            skipped,
            totalSeconds: 0,
            warnings: [],
            items: [],
            planId: this.repos.schedule.plan(date, hour)?.id ?? null,
          });
          continue;
        }
        const start = hourStartMs(date, hour, tz)!;
        const pools = this.pool(date, hour, settings, plays);
        const result = generateHour({
          date,
          hour,
          hourStartMs: start,
          blocks: override.blocks ?? this.template(),
          settings,
          pools,
          news: {
            hour: this.newsCandidate(settings.news_path_hour),
            half: this.newsCandidate(settings.news_path_half),
          },
          separation: sep,
          seed: req.dryRun ? "preview" : "pm",
        });
        let planId: number | null = null;
        if (!req.dryRun) {
          const saved = this.repos.schedule.savePlan({
            date,
            hour,
            status: "ready",
            totalSeconds: result.totalSeconds,
            warnings: result.warnings,
            snapshot: {
              generatedAt: new Date(nowMs).toISOString(),
              mode,
              pools: pools.source,
              settings,
              stats: result.stats,
              items: result.items,
            },
            items: result.items.map((i) => ({
              mediaId: i.mediaId,
              kind: i.kind,
              startSeconds: i.startSeconds,
              length: i.length,
              playlistId: i.playlistId,
              artist: i.artist,
              title: i.title,
              locked: i.locked,
            })),
          });
          planId = saved.id;
          changed.push({ date, hour });
        }
        warnings.push(...result.warnings.map((w) => `${date} ${hour}:00 ${w}`));
        plans.push({
          date,
          hour,
          status: "ready",
          skipped: null,
          totalSeconds: result.totalSeconds,
          warnings: result.warnings,
          items: result.items,
          planId,
        });
      }
      if (runId !== null)
        this.repos.schedule.finishRun(
          runId,
          warnings.length ? "warning" : plans.every((p) => p.skipped) ? "skipped" : "ok",
          warnings,
        );
      if (warnings.length && !req.dryRun) {
        this.alert({
          type: "generator_warning",
          severity: "warning",
          message: `Generator produced ${warnings.length} warning(s) for ${date}`,
          details: { warnings: warnings.slice(0, 20) },
        });
      }
      if (changed.length) this.onPlansChanged(changed);
      return { runId, plans };
    } catch (error) {
      if (runId !== null)
        this.repos.schedule.finishRun(runId, "failed", warnings, (error as Error).message);
      this.alert({
        type: "generator_failed",
        severity: "error",
        message: `Generator failed: ${(error as Error).message}`,
      });
      throw error;
    }
  }

  /** 23:00 trigger: hour 0 of tomorrow. */
  generateTomorrowHour0(nowMs = Date.now()) {
    const today = stationNow(this.tz, nowMs).date;
    return this.generate({ date: addDays(today, 1), hours: [0], runType: "hour0", nowMs });
  }

  /** 00:05 trigger: hours 1–23 of today. */
  generateRestOfToday(nowMs = Date.now()) {
    return this.generate({
      hours: Array.from({ length: 23 }, (_, i) => i + 1),
      runType: "rest",
      nowMs,
    });
  }

  /**
   * Integrity check (M3.6): 24 slots exist; every future hour in the next 24 h
   * has a plan (missing ones are generated) — raises `generator_gap` otherwise.
   */
  integrityCheck(nowMs = Date.now()): { slots: number; missing: string[]; generated: string[] } {
    const tz = this.tz;
    const slots = new Set(
      this.repos.schedule
        .slots()
        .filter((s) => s.enabled)
        .map((s) => s.hour),
    );
    const missing: string[] = [];
    const generated: string[] = [];
    if (slots.size < 24) {
      this.alert({
        type: "schedule_slots",
        severity: "warning",
        message: `Only ${slots.size}/24 hourly schedule slots are enabled`,
      });
    }
    const now = stationNow(tz, nowMs);
    const targets: { date: string; hour: number }[] = [];
    for (let i = 0; i <= 24; i += 1) {
      const t = stationNow(tz, nowMs + i * 3_600_000);
      targets.push({ date: t.date, hour: t.hour });
    }
    const byDate = new Map<string, number[]>();
    for (const t of targets) {
      const override = this.overrideFor(t.date, t.hour);
      if (override.live || override.disabled) continue;
      if (!this.repos.schedule.plan(t.date, t.hour)) {
        missing.push(`${t.date} ${t.hour}:00`);
        const isCurrent = t.date === now.date && t.hour === now.hour;
        if (!isCurrent) byDate.set(t.date, [...(byDate.get(t.date) ?? []), t.hour]);
      }
    }
    for (const [date, hours] of byDate) {
      const r = this.generate({ date, hours, runType: "catchup", nowMs });
      generated.push(...r.plans.filter((p) => !p.skipped).map((p) => `${p.date} ${p.hour}:00`));
    }
    const stillMissing = missing.filter((m) => !generated.includes(m));
    if (stillMissing.length) {
      this.alert({
        type: "generator_gap",
        severity: "error",
        message: `No plan for ${stillMissing.length} upcoming hour(s): ${stillMissing.slice(0, 6).join(", ")}`,
        details: { missing: stillMissing },
      });
    } else {
      this.repos.alerts.resolveType("generator_gap");
    }
    return { slots: slots.size, missing, generated };
  }

  /**
   * News reprocess (M3.6): re-probe the news files; if a duration changed,
   * update the media row and regenerate future plans of today and tomorrow.
   */
  async reprocessNews(nowMs = Date.now()): Promise<{ changed: string[]; regenerated: number }> {
    const settings = this.settings();
    const changed: string[] = [];
    for (const rel of [settings.news_path_hour, settings.news_path_half]) {
      const m = this.repos.media.findByRelativePath(rel.replace(/^\//, ""));
      if (!m) continue;
      try {
        const probe = await probeFile(m.path);
        if (probe.duration && Math.abs((m.duration ?? 0) - probe.duration) > 0.5) {
          this.repos.media.update(m.id, { duration: probe.duration, status: "ok" });
          changed.push(rel);
        }
      } catch {
        this.repos.media.update(m.id, { status: "missing" });
        this.alert({
          type: "news_missing",
          severity: "error",
          message: `News file unreadable: ${rel}`,
        });
      }
    }
    let regenerated = 0;
    if (changed.length) {
      const today = stationNow(this.tz, nowMs).date;
      for (const date of [today, addDays(today, 1)]) {
        const hours = this.repos.schedule.plansForDate(date).map((p) => p.hour);
        if (hours.length === 0) continue;
        const r = this.generate({ date, hours, runType: "news-reprocess", nowMs });
        regenerated += r.plans.filter((p) => !p.skipped).length;
      }
    }
    return { changed, regenerated };
  }
}

/**
 * Internal timers (M3.5): checks every 30 s whether a trigger time passed since
 * the last run (missed-trigger catch-up survives restarts via generator_runs),
 * plus 5-minute news reprocess and integrity check.
 */
export class GeneratorScheduler {
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly service: GeneratorService,
    private readonly repos: Repositories,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /** Returns which triggers are due at `nowMs` (exported for tests). */
  dueTriggers(nowMs: number): ("hour0" | "rest")[] {
    const tz = this.service.tz;
    const settings = this.service.settings();
    const now = stationNow(tz, nowMs);
    const due: ("hour0" | "rest")[] = [];
    const check = (runType: "hour0" | "rest", at: string) => {
      const { hour, minute } = parseHHMM(at);
      if (minuteOfDay(now) < hour * 60 + minute) return;
      const todayTrigger = hourStartMs(now.date, hour, tz);
      if (todayTrigger === null) return;
      const triggerMs = todayTrigger + minute * 60_000;
      const last = this.repos.schedule.lastRun(runType);
      if (!last || Date.parse(last.started_at) < triggerMs) due.push(runType);
    };
    check("rest", settings.generate_rest_at);
    check("hour0", settings.generate_hour_00_at);
    return due;
  }

  tick(nowMs = Date.now()): void {
    for (const trigger of this.dueTriggers(nowMs)) {
      try {
        const r =
          trigger === "hour0"
            ? this.service.generateTomorrowHour0(nowMs)
            : this.service.generateRestOfToday(nowMs);
        this.log(`generator ${trigger}: ${r.plans.filter((p) => !p.skipped).length} plans`);
      } catch (error) {
        this.log(`generator ${trigger} failed: ${(error as Error).message}`);
      }
    }
  }

  start(): void {
    this.tick();
    try {
      this.service.integrityCheck();
    } catch (e) {
      this.log(`integrity check failed: ${(e as Error).message}`);
    }
    this.timers.push(setInterval(() => this.tick(), 30_000));
    this.timers.push(
      setInterval(() => {
        void this.service
          .reprocessNews()
          .catch((e) => this.log(`news reprocess failed: ${(e as Error).message}`));
        try {
          this.service.integrityCheck();
        } catch (e) {
          this.log(`integrity check failed: ${(e as Error).message}`);
        }
      }, 5 * 60_000),
    );
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
