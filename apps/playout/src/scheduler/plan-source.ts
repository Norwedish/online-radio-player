/**
 * Read-only plan/media access for the worker (ADR 0005: only radio-api writes).
 */
import { randomUUID } from "node:crypto";
import { hourStartMs } from "@radio/core";
import { createRepositories, openDatabase, type MediaRow, type Repositories } from "@radio/db";
import {
  EMERGENCY_PLAYLIST,
  GENERAL_PLAYLIST,
  JINGLES_PLAYLIST,
  type QueueItem,
} from "@radio/shared";

export interface PlanSource {
  timezone(): string;
  /** Queue items of one hour plan (absolute plannedStart), or null if no plan exists. */
  hourItems(date: string, hour: number): { planId: number; items: QueueItem[] } | null;
  /** Filler candidates up to `maxSeconds` long (General, then Jingles). */
  filler(maxSeconds: number, exclude: Set<number>): QueueItem | null;
  /** Random music for when a plan is missing. */
  fallbackMusic(count: number, exclude: Set<number>): QueueItem[];
  emergencyItems(): QueueItem[];
  media(id: number): MediaRow | undefined;
  setting<T>(key: string, fallback: T): T;
  close(): void;
}

export function mediaToItem(m: MediaRow, extra: Partial<QueueItem> = {}): QueueItem {
  const duration = m.duration ?? 0;
  const cueIn = m.cue_in ?? 0;
  const cueOut = m.cue_out && m.cue_out > 0 ? Math.min(m.cue_out, duration) : null;
  return {
    uid: randomUUID(),
    kind: "music",
    mediaId: m.id,
    path: m.path,
    title: m.title ?? "",
    artist: m.artist ?? "",
    duration: Math.max(0, (cueOut ?? duration) - cueIn),
    cueIn,
    cueOut,
    fadeIn: m.fade_in ?? 0,
    fadeOut: m.fade_out ?? 0,
    gainDb: m.gain_db ?? 0,
    planId: null,
    planItemId: null,
    plannedStart: null,
    locked: false,
    source: "automation",
    requestId: null,
    artworkUrl: m.artwork_path ? `/api/media/${m.id}/artwork` : null,
    intro: m.intro_end && m.intro_end > cueIn ? m.intro_end - cueIn : null,
    outro: m.outro_start && m.outro_start > cueIn ? m.outro_start - cueIn : null,
    ...extra,
  };
}

export class SqlitePlanSource implements PlanSource {
  private readonly repos: Repositories;

  constructor(
    dbFile: string,
    private readonly fallbackTz: string,
  ) {
    this.repos = createRepositories(openDatabase(dbFile, { readonly: true }));
  }

  timezone(): string {
    try {
      return this.repos.stations.get(1)?.timezone ?? this.fallbackTz;
    } catch {
      return this.fallbackTz;
    }
  }

  hourItems(date: string, hour: number): { planId: number; items: QueueItem[] } | null {
    const plan = this.repos.schedule.plan(date, hour);
    if (!plan) return null;
    const start = hourStartMs(date, hour, this.timezone());
    if (start === null) return null;
    const rows = this.repos.schedule.items(plan.id);
    const media = new Map(
      this.repos.media
        .getMany(rows.map((r) => r.media_id).filter((id): id is number => id !== null))
        .map((m) => [m.id, m]),
    );
    const items: QueueItem[] = [];
    for (const row of rows) {
      if (row.kind === "live") continue;
      const m = row.media_id !== null ? media.get(row.media_id) : undefined;
      if (!m || m.status === "missing" || m.status === "disabled") continue;
      items.push(
        mediaToItem(m, {
          kind: row.kind,
          planId: plan.id,
          planItemId: row.id,
          plannedStart: start + row.start_seconds * 1000,
          locked: row.is_locked,
          duration:
            row.length > 0
              ? Math.min(row.length, mediaToItem(m).duration || row.length)
              : mediaToItem(m).duration,
        }),
      );
    }
    return { planId: plan.id, items };
  }

  private poolOf(name: string): MediaRow[] {
    const pl = this.repos.playlists.getByName(name);
    if (!pl) return [];
    return this.repos.playlists.pool([pl.id]).map((p) => p.media);
  }

  filler(maxSeconds: number, exclude: Set<number>): QueueItem | null {
    for (const name of [GENERAL_PLAYLIST, JINGLES_PLAYLIST]) {
      const fits = this.poolOf(name).filter(
        (m) => !exclude.has(m.id) && (m.duration ?? 0) > 0 && (m.duration ?? 0) <= maxSeconds,
      );
      if (fits.length) {
        // Longest that fits keeps the gap smallest.
        fits.sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0));
        const pick = fits[Math.floor(Math.random() * Math.min(3, fits.length))]!;
        return mediaToItem(pick, { kind: name === JINGLES_PLAYLIST ? "jingle" : "music" });
      }
    }
    return null;
  }

  fallbackMusic(count: number, exclude: Set<number>): QueueItem[] {
    let pool = this.poolOf(GENERAL_PLAYLIST).filter((m) => !exclude.has(m.id));
    if (pool.length === 0)
      pool = this.repos.media
        .search({ status: "ok", limit: 500 })
        .items.filter((m) => (m.duration ?? 0) > 30 && !exclude.has(m.id));
    const out: QueueItem[] = [];
    const copy = [...pool];
    while (out.length < count && copy.length)
      out.push(mediaToItem(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]!));
    return out;
  }

  emergencyItems(): QueueItem[] {
    return this.poolOf(EMERGENCY_PLAYLIST).map((m) =>
      mediaToItem(m, { kind: "emergency", source: "manual" }),
    );
  }

  media(id: number): MediaRow | undefined {
    return this.repos.media.get(id);
  }

  setting<T>(key: string, fallback: T): T {
    try {
      return this.repos.settings.get(key, fallback);
    } catch {
      return fallback;
    }
  }

  close(): void {
    this.repos.db.close();
  }
}
