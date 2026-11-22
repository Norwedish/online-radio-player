import type Database from "better-sqlite3";
import { buildSet, fromJson, nowIso, toJson } from "../util.js";
import type {
  AlertRow,
  AuditRow,
  EventRow,
  LiveSessionRow,
  PlayHistoryRow,
  RequestRow,
  StationRow,
} from "./types.js";

type Raw = Record<string, unknown>;

export class StationRepository {
  constructor(private readonly db: Database.Database) {}

  get(id: number): StationRow | undefined {
    const row = this.db.prepare("SELECT * FROM stations WHERE id = ?").get(id) as Raw | undefined;
    if (!row) return undefined;
    const { colors_json, ...rest } = row;
    return { ...(rest as unknown as StationRow), colors: fromJson(colors_json as string, {}) };
  }

  update(
    id: number,
    patch: Partial<{
      name: string;
      timezone: string;
      locale: string;
      logo_url: string | null;
      colors: Record<string, string>;
    }>,
  ): StationRow | undefined {
    const p: Record<string, unknown> = { ...patch };
    if (patch.colors) {
      p.colors_json = toJson(patch.colors);
      delete p.colors;
    }
    const { sql, params } = buildSet(p, ["name", "timezone", "locale", "logo_url", "colors_json"]);
    if (sql)
      this.db
        .prepare(`UPDATE stations SET ${sql}, updated_at = @now WHERE id = @id`)
        .run({ ...params, now: nowIso(), id });
    return this.get(id);
  }
}

/** Key/value settings (typed JSON). Keys are global in v1 (single station). */
export class SettingsRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly stationId: number,
  ) {}

  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as
      Raw | undefined;
    return fromJson<T>(row?.value_json as string | undefined, fallback);
  }

  has(key: string): boolean {
    return this.db.prepare("SELECT 1 FROM settings WHERE key = ?").get(key) !== undefined;
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (station_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(this.stationId, key, toJson(value), nowIso());
  }

  all(prefix = ""): Record<string, unknown> {
    const rows = this.db
      .prepare(
        "SELECT key, value_json FROM settings WHERE key LIKE ? AND key NOT LIKE 'user.%' ORDER BY key",
      )
      .all(`${prefix}%`) as { key: string; value_json: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, fromJson(r.value_json, null)]));
  }
}

/** Append-only audit log: there is deliberately no update/delete method. */
export class AuditRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly stationId: number,
  ) {}

  write(entry: {
    userId: number | null;
    action: string;
    entityType?: string | null;
    entityId?: number | null;
    metadata?: unknown;
    ip?: string | null;
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO audit_log (station_id, user_id, action, entity_type, entity_id, metadata_json, ip, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.stationId,
        entry.userId,
        entry.action,
        entry.entityType ?? null,
        entry.entityId ?? null,
        entry.metadata === undefined ? null : toJson(entry.metadata),
        entry.ip ?? null,
        nowIso(),
      );
    return Number(info.lastInsertRowid);
  }

  list(
    filter: {
      userId?: number;
      action?: string;
      entityType?: string;
      since?: string;
      until?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): { items: AuditRow[]; total: number } {
    const where = ["a.station_id = @sid"];
    const params: Record<string, unknown> = { sid: this.stationId };
    if (filter.userId !== undefined) {
      where.push("a.user_id = @userId");
      params.userId = filter.userId;
    }
    if (filter.action) {
      where.push("a.action LIKE @action");
      params.action = `${filter.action}%`;
    }
    if (filter.entityType) {
      where.push("a.entity_type = @entityType");
      params.entityType = filter.entityType;
    }
    if (filter.since) {
      where.push("a.created_at >= @since");
      params.since = filter.since;
    }
    if (filter.until) {
      where.push("a.created_at <= @until");
      params.until = filter.until;
    }
    const w = where.join(" AND ");
    const total = Number(
      (this.db.prepare(`SELECT COUNT(*) AS n FROM audit_log a WHERE ${w}`).get(params) as Raw).n,
    );
    const items = (
      this.db
        .prepare(
          `SELECT a.*, u.username FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE ${w} ORDER BY a.id DESC LIMIT @limit OFFSET @offset`,
        )
        .all({
          ...params,
          limit: Math.min(filter.limit ?? 100, 1000),
          offset: filter.offset ?? 0,
        }) as Raw[]
    ).map((r) => {
      const { metadata_json, ...rest } = r;
      return {
        ...(rest as unknown as AuditRow),
        metadata: fromJson(metadata_json as string, null),
      };
    });
    return { items, total };
  }
}

function mapAlert(r: Raw): AlertRow {
  const { details_json, ...rest } = r;
  return { ...(rest as unknown as AlertRow), details: fromJson(details_json as string, null) };
}

export class AlertRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly stationId: number,
  ) {}

  create(input: {
    type: string;
    severity: AlertRow["severity"];
    message: string;
    details?: unknown;
  }): AlertRow {
    const info = this.db
      .prepare(
        "INSERT INTO alerts (station_id, type, severity, message, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        this.stationId,
        input.type,
        input.severity,
        input.message,
        input.details === undefined ? null : toJson(input.details),
        nowIso(),
      );
    return this.get(Number(info.lastInsertRowid))!;
  }

  get(id: number): AlertRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM alerts WHERE id = ? AND station_id = ?")
      .get(id, this.stationId) as Raw | undefined;
    return r ? mapAlert(r) : undefined;
  }

  /** Most recent unresolved alert of the same type (for throttling/dedupe). */
  latestOpen(type: string): AlertRow | undefined {
    const r = this.db
      .prepare(
        "SELECT * FROM alerts WHERE station_id = ? AND type = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1",
      )
      .get(this.stationId, type) as Raw | undefined;
    return r ? mapAlert(r) : undefined;
  }

  list(filter: { active?: boolean; severity?: string; limit?: number; offset?: number } = {}): {
    items: AlertRow[];
    total: number;
  } {
    const where = ["station_id = @sid"];
    const params: Record<string, unknown> = { sid: this.stationId };
    if (filter.active) where.push("resolved_at IS NULL AND acknowledged_at IS NULL");
    if (filter.severity) {
      where.push("severity = @severity");
      params.severity = filter.severity;
    }
    const w = where.join(" AND ");
    const total = Number(
      (this.db.prepare(`SELECT COUNT(*) AS n FROM alerts WHERE ${w}`).get(params) as Raw).n,
    );
    const items = (
      this.db
        .prepare(`SELECT * FROM alerts WHERE ${w} ORDER BY id DESC LIMIT @limit OFFSET @offset`)
        .all({
          ...params,
          limit: Math.min(filter.limit ?? 100, 1000),
          offset: filter.offset ?? 0,
        }) as Raw[]
    ).map(mapAlert);
    return { items, total };
  }

  acknowledge(id: number, userId: number | null): boolean {
    return (
      this.db
        .prepare(
          "UPDATE alerts SET acknowledged_at = ?, acknowledged_by = ? WHERE id = ? AND station_id = ? AND acknowledged_at IS NULL",
        )
        .run(nowIso(), userId, id, this.stationId).changes > 0
    );
  }

  resolveType(type: string): number {
    return this.db
      .prepare(
        "UPDATE alerts SET resolved_at = ? WHERE station_id = ? AND type = ? AND resolved_at IS NULL",
      )
      .run(nowIso(), this.stationId, type).changes;
  }

  countActive(): number {
    return Number(
      (
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM alerts WHERE station_id = ? AND resolved_at IS NULL AND acknowledged_at IS NULL",
          )
          .get(this.stationId) as Raw
      ).n,
    );
  }
}

export class RequestRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly stationId: number,
  ) {}

  create(input: {
    ip: string;
    displayName?: string | null;
    contact?: string | null;
    artist?: string | null;
    title?: string | null;
    message?: string | null;
    dedication?: string | null;
    mediaId?: number | null;
    status?: RequestRow["status"];
  }): RequestRow {
    const info = this.db
      .prepare(
        `INSERT INTO requests (station_id, listener_ip, display_name, contact, artist, title, message, dedication, media_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.stationId,
        input.ip,
        input.displayName ?? null,
        input.contact ?? null,
        input.artist ?? null,
        input.title ?? null,
        input.message ?? null,
        input.dedication ?? null,
        input.mediaId ?? null,
        input.status ?? "pending",
        nowIso(),
      );
    return this.get(Number(info.lastInsertRowid))!;
  }

  get(id: number): RequestRow | undefined {
    return this.db
      .prepare("SELECT * FROM requests WHERE id = ? AND station_id = ?")
      .get(id, this.stationId) as RequestRow | undefined;
  }

  list(filter: { status?: string; limit?: number; offset?: number } = {}): {
    items: RequestRow[];
    total: number;
  } {
    const where = ["station_id = @sid"];
    const params: Record<string, unknown> = { sid: this.stationId };
    if (filter.status) {
      where.push("status = @status");
      params.status = filter.status;
    }
    const w = where.join(" AND ");
    const total = Number(
      (this.db.prepare(`SELECT COUNT(*) AS n FROM requests WHERE ${w}`).get(params) as Raw).n,
    );
    const items = this.db
      .prepare(`SELECT * FROM requests WHERE ${w} ORDER BY id DESC LIMIT @limit OFFSET @offset`)
      .all({
        ...params,
        limit: Math.min(filter.limit ?? 100, 500),
        offset: filter.offset ?? 0,
      }) as RequestRow[];
    return { items, total };
  }

  moderate(
    id: number,
    status: RequestRow["status"],
    userId: number | null,
    playAfter?: number,
  ): RequestRow | undefined {
    this.db
      .prepare(
        "UPDATE requests SET status = ?, moderated_by = ?, moderated_at = ?, play_after = COALESCE(?, play_after) WHERE id = ? AND station_id = ?",
      )
      .run(status, userId, nowIso(), playAfter ?? null, id, this.stationId);
    return this.get(id);
  }

  markPlayed(id: number): void {
    this.db
      .prepare("UPDATE requests SET status = 'played', played_at = ? WHERE id = ?")
      .run(nowIso(), id);
  }

  setMedia(id: number, mediaId: number | null): void {
    this.db.prepare("UPDATE requests SET media_id = ? WHERE id = ?").run(mediaId, id);
  }

  /** Most recent request from an IP (cooldown check). */
  lastFromIp(ip: string): RequestRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM requests WHERE station_id = ? AND listener_ip = ? ORDER BY id DESC LIMIT 1",
      )
      .get(this.stationId, ip) as RequestRow | undefined;
  }

  countFromIpSince(ip: string, since: string): number {
    return Number(
      (
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM requests WHERE station_id = ? AND listener_ip = ? AND created_at >= ?",
          )
          .get(this.stationId, ip, since) as Raw
      ).n,
    );
  }

  /** Increments the hourly window counter and returns the new count (M11.3 rate limit). */
  hitRateLimit(ip: string, windowStart: string): number {
    this.db
      .prepare(
        `INSERT INTO request_rate_limits (station_id, ip, window_start, count) VALUES (?, ?, ?, 1)
         ON CONFLICT(station_id, ip, window_start) DO UPDATE SET count = count + 1`,
      )
      .run(this.stationId, ip, windowStart);
    return Number(
      (
        this.db
          .prepare(
            "SELECT count FROM request_rate_limits WHERE station_id = ? AND ip = ? AND window_start = ?",
          )
          .get(this.stationId, ip, windowStart) as Raw
      ).count,
    );
  }

  blacklist(): { id: number; pattern: string; match_type: string; created_at: string }[] {
    return this.db
      .prepare(
        "SELECT id, pattern, match_type, created_at FROM request_blacklist WHERE station_id = ? ORDER BY pattern",
      )
      .all(this.stationId) as never;
  }

  addBlacklist(
    pattern: string,
    matchType: "contains" | "exact" | "artist" | "title",
    userId: number | null,
  ): number {
    return Number(
      this.db
        .prepare(
          "INSERT INTO request_blacklist (station_id, pattern, match_type, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(this.stationId, pattern, matchType, userId, nowIso()).lastInsertRowid,
    );
  }

  removeBlacklist(id: number): boolean {
    return (
      this.db
        .prepare("DELETE FROM request_blacklist WHERE id = ? AND station_id = ?")
        .run(id, this.stationId).changes > 0
    );
  }

  countByStatus(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM requests WHERE station_id = ? GROUP BY status")
      .all(this.stationId) as { status: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }
}

export class EventRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly stationId: number,
  ) {}

  list(filter: { from?: string; status?: string } = {}): EventRow[] {
    const where = ["station_id = @sid"];
    const params: Record<string, unknown> = { sid: this.stationId };
    if (filter.from) {
      where.push("(end_at IS NULL OR end_at >= @from)");
      params.from = filter.from;
    }
    if (filter.status) {
      where.push("status = @status");
      params.status = filter.status;
    }
    return this.db
      .prepare(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY start_at`)
      .all(params) as EventRow[];
  }

  get(id: number): EventRow | undefined {
    return this.db
      .prepare("SELECT * FROM events WHERE id = ? AND station_id = ?")
      .get(id, this.stationId) as EventRow | undefined;
  }

  create(input: {
    title: string;
    type: EventRow["type"];
    startAt: string;
    endAt?: string | null;
    priority: number;
    playlistId?: number | null;
    createdBy: number | null;
  }): EventRow {
    const info = this.db
      .prepare(
        `INSERT INTO events (station_id, title, type, start_at, end_at, priority, playlist_id, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
      )
      .run(
        this.stationId,
        input.title,
        input.type,
        input.startAt,
        input.endAt ?? null,
        input.priority,
        input.playlistId ?? null,
        input.createdBy,
        nowIso(),
      );
    return this.get(Number(info.lastInsertRowid))!;
  }

  update(
    id: number,
    patch: Partial<{
      title: string;
      start_at: string;
      end_at: string | null;
      priority: number;
      playlist_id: number | null;
      status: string;
      ended_at: string | null;
    }>,
  ): EventRow | undefined {
    const { sql, params } = buildSet(patch, [
      "title",
      "start_at",
      "end_at",
      "priority",
      "playlist_id",
      "status",
      "ended_at",
    ]);
    if (sql)
      this.db
        .prepare(`UPDATE events SET ${sql} WHERE id = @id AND station_id = @sid`)
        .run({ ...params, id, sid: this.stationId });
    return this.get(id);
  }

  delete(id: number): boolean {
    return (
      this.db
        .prepare("DELETE FROM events WHERE id = ? AND station_id = ? AND status != 'active'")
        .run(id, this.stationId).changes > 0
    );
  }

  /** Scheduled events whose start time has arrived. */
  due(now: string): EventRow[] {
    return this.db
      .prepare(
        "SELECT * FROM events WHERE station_id = ? AND status = 'scheduled' AND start_at <= ? AND (end_at IS NULL OR end_at > ?) ORDER BY priority DESC, start_at",
      )
      .all(this.stationId, now, now) as EventRow[];
  }

  active(): EventRow[] {
    return this.db
      .prepare(
        "SELECT * FROM events WHERE station_id = ? AND status = 'active' ORDER BY priority DESC",
      )
      .all(this.stationId) as EventRow[];
  }
}

export class HistoryRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly stationId: number,
  ) {}

  start(input: {
    mediaId: number;
    planId: number | null;
    startedAt: string;
    source: PlayHistoryRow["source"];
    listeners?: number | null;
  }): number {
    return Number(
      this.db
        .prepare(
          "INSERT INTO play_history (station_id, media_id, plan_id, started_at, source, listeners_peak, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          this.stationId,
          input.mediaId,
          input.planId,
          input.startedAt,
          input.source,
          input.listeners ?? null,
          nowIso(),
        ).lastInsertRowid,
    );
  }

  end(id: number, endedAt: string, listenersPeak?: number | null): void {
    this.db
      .prepare(
        "UPDATE play_history SET ended_at = ?, listeners_peak = MAX(COALESCE(listeners_peak, 0), COALESCE(?, 0)) WHERE id = ?",
      )
      .run(endedAt, listenersPeak ?? null, id);
  }

  /** Ends the most recent open history row for a media id (worker track_ended event). */
  endLatestOpen(mediaId: number, endedAt: string): void {
    this.db
      .prepare(
        "UPDATE play_history SET ended_at = ? WHERE id = (SELECT id FROM play_history WHERE station_id = ? AND media_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1)",
      )
      .run(endedAt, this.stationId, mediaId);
  }

  recent(limit = 20, offset = 0, since?: string, until?: string): PlayHistoryRow[] {
    return this.db
      .prepare(
        `SELECT h.*, m.title, m.artist, m.album, m.duration, m.artwork_path FROM play_history h JOIN media m ON m.id = h.media_id
         WHERE h.station_id = @sid AND h.started_at >= @since AND h.started_at <= @until ORDER BY h.started_at DESC LIMIT @limit OFFSET @offset`,
      )
      .all({
        sid: this.stationId,
        since: since ?? "0000",
        until: until ?? "9999",
        limit: Math.min(limit, 5000),
        offset,
      }) as PlayHistoryRow[];
  }

  /** Separation seeding for the generator: what actually aired since `since`. */
  playedSince(since: string): { media_id: number; artist: string | null; started_at: string }[] {
    return this.db
      .prepare(
        "SELECT h.media_id, m.artist, h.started_at FROM play_history h JOIN media m ON m.id = h.media_id WHERE h.station_id = ? AND h.started_at >= ?",
      )
      .all(this.stationId, since) as never;
  }

  playCounts(since: string): Map<number, number> {
    const rows = this.db
      .prepare(
        "SELECT media_id, COUNT(*) AS n FROM play_history WHERE station_id = ? AND started_at >= ? GROUP BY media_id",
      )
      .all(this.stationId, since) as { media_id: number; n: number }[];
    return new Map(rows.map((r) => [r.media_id, Number(r.n)]));
  }

  airplay(
    since: string,
    until: string,
  ): {
    perHour: { hour: string; plays: number }[];
    perDay: { day: string; plays: number }[];
    topTracks: { media_id: number; title: string | null; artist: string | null; plays: number }[];
    topArtists: { artist: string | null; plays: number }[];
    uniqueArtists: number;
    totalPlays: number;
    bySource: Record<string, number>;
  } {
    const p = { sid: this.stationId, since, until };
    const base =
      "FROM play_history h JOIN media m ON m.id = h.media_id WHERE h.station_id = @sid AND h.started_at >= @since AND h.started_at < @until";
    return {
      perHour: this.db
        .prepare(
          `SELECT substr(h.started_at, 12, 2) AS hour, COUNT(*) AS plays ${base} GROUP BY hour ORDER BY hour`,
        )
        .all(p) as never,
      perDay: this.db
        .prepare(
          `SELECT substr(h.started_at, 1, 10) AS day, COUNT(*) AS plays ${base} GROUP BY day ORDER BY day`,
        )
        .all(p) as never,
      topTracks: this.db
        .prepare(
          `SELECT h.media_id, m.title, m.artist, COUNT(*) AS plays ${base} GROUP BY h.media_id ORDER BY plays DESC LIMIT 25`,
        )
        .all(p) as never,
      topArtists: this.db
        .prepare(
          `SELECT m.artist, COUNT(*) AS plays ${base} GROUP BY m.artist ORDER BY plays DESC LIMIT 25`,
        )
        .all(p) as never,
      uniqueArtists: Number(
        (this.db.prepare(`SELECT COUNT(DISTINCT m.artist) AS n ${base}`).get(p) as Raw).n,
      ),
      totalPlays: Number((this.db.prepare(`SELECT COUNT(*) AS n ${base}`).get(p) as Raw).n),
      bySource: Object.fromEntries(
        (
          this.db.prepare(`SELECT h.source, COUNT(*) AS n ${base} GROUP BY h.source`).all(p) as {
            source: string;
            n: number;
          }[]
        ).map((r) => [r.source, Number(r.n)]),
      ),
    };
  }

  purgeBefore(before: string): number {
    return this.db
      .prepare("DELETE FROM play_history WHERE station_id = ? AND started_at < ?")
      .run(this.stationId, before).changes;
  }
}

export class ListenerStatsRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly stationId: number,
  ) {}

  record(ts: string, samples: { mount: string; listeners: number }[]): void {
    const ins = this.db.prepare(
      "INSERT INTO listener_stats (station_id, ts, mount, listeners) VALUES (?, ?, ?, ?)",
    );
    const tx = this.db.transaction(() =>
      samples.forEach((s) => ins.run(this.stationId, ts, s.mount, s.listeners)),
    );
    tx();
  }

  series(
    since: string,
    until: string,
    bucketMinutes = 5,
  ): { ts: string; mount: string; listeners: number }[] {
    // Bucket by truncating the ISO timestamp to the bucket size in SQL.
    const seconds = Math.max(1, bucketMinutes) * 60;
    return this.db
      .prepare(
        `SELECT strftime('%Y-%m-%dT%H:%M:00Z', (CAST(strftime('%s', ts) AS INTEGER) / @s) * @s, 'unixepoch') AS bucket, mount, MAX(listeners) AS listeners
         FROM listener_stats WHERE station_id = @sid AND ts >= @since AND ts < @until GROUP BY bucket, mount ORDER BY bucket`,
      )
      .all({ s: seconds, sid: this.stationId, since, until })
      .map((r) => ({
        ts: String((r as Raw).bucket),
        mount: String((r as Raw).mount),
        listeners: Number((r as Raw).listeners),
      }));
  }

  current(): { mount: string; listeners: number; ts: string }[] {
    return this.db
      .prepare(
        `SELECT mount, listeners, ts FROM listener_stats WHERE station_id = ? AND ts = (SELECT MAX(ts) FROM listener_stats WHERE station_id = ?)`,
      )
      .all(this.stationId, this.stationId) as never;
  }

  peak(since: string, until = "9999"): number {
    const row = this.db
      .prepare(
        "SELECT MAX(total) AS peak FROM (SELECT ts, SUM(listeners) AS total FROM listener_stats WHERE station_id = ? AND ts >= ? AND ts <= ? GROUP BY ts)",
      )
      .get(this.stationId, since, until) as Raw;
    return Number(row.peak ?? 0);
  }

  purgeBefore(before: string): number {
    return this.db
      .prepare("DELETE FROM listener_stats WHERE station_id = ? AND ts < ?")
      .run(this.stationId, before).changes;
  }
}

export class LiveSessionRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly stationId: number,
  ) {}

  start(input: {
    userId: number | null;
    mode: "duck" | "takeover";
    recordedPath?: string | null;
    notes?: string | null;
  }): LiveSessionRow {
    const now = nowIso();
    const info = this.db
      .prepare(
        "INSERT INTO live_sessions (station_id, user_id, mode, started_at, recorded_path, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        this.stationId,
        input.userId,
        input.mode,
        now,
        input.recordedPath ?? null,
        input.notes ?? null,
        now,
      );
    return this.get(Number(info.lastInsertRowid))!;
  }

  get(id: number): LiveSessionRow | undefined {
    return this.db
      .prepare(
        "SELECT s.*, u.username FROM live_sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.station_id = ?",
      )
      .get(id, this.stationId) as LiveSessionRow | undefined;
  }

  open(): LiveSessionRow | undefined {
    return this.db
      .prepare(
        "SELECT s.*, u.username FROM live_sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.station_id = ? AND s.ended_at IS NULL ORDER BY s.id DESC LIMIT 1",
      )
      .get(this.stationId) as LiveSessionRow | undefined;
  }

  end(
    id: number,
    input: { recordedSize?: number | null; peakListeners?: number | null },
  ): LiveSessionRow | undefined {
    const session = this.get(id);
    if (!session) return undefined;
    const ended = new Date();
    const duration = (ended.getTime() - Date.parse(session.started_at)) / 1000;
    this.db
      .prepare(
        "UPDATE live_sessions SET ended_at = ?, duration = ?, recorded_size = ?, peak_listeners = ? WHERE id = ?",
      )
      .run(
        ended.toISOString(),
        duration,
        input.recordedSize ?? null,
        input.peakListeners ?? null,
        id,
      );
    return this.get(id);
  }

  list(
    filter: { userId?: number; since?: string; until?: string; limit?: number } = {},
  ): LiveSessionRow[] {
    const where = ["s.station_id = @sid"];
    const params: Record<string, unknown> = { sid: this.stationId };
    if (filter.userId !== undefined) {
      where.push("s.user_id = @uid");
      params.uid = filter.userId;
    }
    if (filter.since) {
      where.push("s.started_at >= @since");
      params.since = filter.since;
    }
    if (filter.until) {
      where.push("s.started_at <= @until");
      params.until = filter.until;
    }
    return this.db
      .prepare(
        `SELECT s.*, u.username FROM live_sessions s LEFT JOIN users u ON u.id = s.user_id WHERE ${where.join(" AND ")} ORDER BY s.started_at DESC LIMIT @limit`,
      )
      .all({ ...params, limit: filter.limit ?? 200 }) as LiveSessionRow[];
  }

  recordings(): LiveSessionRow[] {
    return this.db
      .prepare(
        "SELECT s.*, u.username FROM live_sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.station_id = ? AND s.recorded_path IS NOT NULL ORDER BY s.started_at DESC",
      )
      .all(this.stationId) as LiveSessionRow[];
  }

  clearRecording(id: number): void {
    this.db
      .prepare("UPDATE live_sessions SET recorded_path = NULL, recorded_size = NULL WHERE id = ?")
      .run(id);
  }

  expiredRecordings(before: string): LiveSessionRow[] {
    return this.db
      .prepare(
        "SELECT * FROM live_sessions WHERE station_id = ? AND recorded_path IS NOT NULL AND started_at < ?",
      )
      .all(this.stationId, before) as LiveSessionRow[];
  }

  shiftReport(
    since: string,
    until: string,
  ): {
    user_id: number | null;
    username: string | null;
    sessions: number;
    total_seconds: number;
    peak_listeners: number;
  }[] {
    return this.db
      .prepare(
        `SELECT s.user_id, u.username, COUNT(*) AS sessions, COALESCE(SUM(s.duration), 0) AS total_seconds, COALESCE(MAX(s.peak_listeners), 0) AS peak_listeners
         FROM live_sessions s LEFT JOIN users u ON u.id = s.user_id
         WHERE s.station_id = ? AND s.started_at >= ? AND s.started_at < ? GROUP BY s.user_id ORDER BY total_seconds DESC`,
      )
      .all(this.stationId, since, until) as never;
  }
}

export class BackupRepository {
  constructor(private readonly db: Database.Database) {}

  record(path: string, type: string, size: number, verified: boolean): number {
    const now = nowIso();
    return Number(
      this.db
        .prepare(
          "INSERT INTO backups (path, type, size, created_at, verified_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(path, type, size, now, verified ? now : null).lastInsertRowid,
    );
  }

  list(
    limit = 100,
  ): {
    id: number;
    path: string;
    type: string;
    size: number;
    created_at: string;
    verified_at: string | null;
  }[] {
    return this.db.prepare("SELECT * FROM backups ORDER BY id DESC LIMIT ?").all(limit) as never;
  }

  forget(paths: string[]): void {
    const del = this.db.prepare("DELETE FROM backups WHERE path = ?");
    const tx = this.db.transaction(() => paths.forEach((p) => del.run(p)));
    tx();
  }
}
