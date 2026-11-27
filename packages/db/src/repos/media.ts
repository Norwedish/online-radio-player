import type Database from "better-sqlite3";
import { bool, buildSet, fromJson, nowIso, toJson } from "../util.js";
import type { MediaRow, MediaStatus, PlaylistItemRow, PlaylistRole, PlaylistRow } from "./types.js";

type Raw = Record<string, unknown>;

function mapMedia(row: Raw | undefined): MediaRow | undefined {
  if (!row) return undefined;
  const { tags_json, ...rest } = row;
  return { ...(rest as unknown as MediaRow), tags: fromJson(tags_json as string, {}) };
}

export const MEDIA_WRITABLE = [
  "relative_path",
  "title",
  "artist",
  "artist_sort",
  "album",
  "album_artist",
  "genre",
  "year",
  "duration",
  "sample_rate",
  "channels",
  "bitrate",
  "codec",
  "loudness_lufs",
  "peak_db",
  "gain_db",
  "cue_in",
  "cue_out",
  "intro_end",
  "outro_start",
  "fade_in",
  "fade_out",
  "autocue_json",
  "loudness_envelope",
  "cue_source",
  "artwork_path",
  "hash",
  "size",
  "mtime",
  "status",
] as const;

export type MediaInput = Partial<Pick<MediaRow, (typeof MEDIA_WRITABLE)[number]>> & {
  path: string;
  tags?: Record<string, unknown>;
};

export interface MediaQuery {
  q?: string;
  artist?: string;
  title?: string;
  album?: string;
  status?: MediaStatus;
  minDuration?: number;
  maxDuration?: number;
  minLufs?: number;
  maxLufs?: number;
  duplicates?: boolean;
  missingTags?: boolean;
  playlistId?: number;
  pathPrefix?: string;
  sort?: "artist" | "title" | "album" | "duration" | "created_at" | "loudness_lufs";
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export class MediaRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly stationId: number,
  ) {}

  get(id: number): MediaRow | undefined {
    return mapMedia(
      this.db
        .prepare("SELECT * FROM media WHERE id = ? AND station_id = ?")
        .get(id, this.stationId) as Raw,
    );
  }

  getMany(ids: number[]): MediaRow[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM media WHERE station_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(this.stationId, ...ids);
    return rows.map((r) => mapMedia(r as Raw)!);
  }

  getByPath(path: string): MediaRow | undefined {
    return mapMedia(this.db.prepare("SELECT * FROM media WHERE path = ?").get(path) as Raw);
  }

  findByRelativePath(relative: string): MediaRow | undefined {
    return mapMedia(
      this.db
        .prepare(
          "SELECT * FROM media WHERE station_id = ? AND (relative_path = ? OR relative_path = ? OR path LIKE ?) ORDER BY id LIMIT 1",
        )
        .get(
          this.stationId,
          relative,
          relative.replace(/^\//, ""),
          `%/${relative.replace(/^\//, "")}`,
        ) as Raw,
    );
  }

  /** Insert or update by absolute path; returns the row and whether it was created. */
  upsert(input: MediaInput): { row: MediaRow; created: boolean } {
    const existing = this.getByPath(input.path);
    const now = nowIso();
    if (existing) {
      const patch: Record<string, unknown> = { ...input };
      delete patch.path;
      delete patch.tags;
      const { sql, params } = buildSet(patch, MEDIA_WRITABLE);
      const tagsSql = input.tags ? ", tags_json = @tags_json" : "";
      this.db
        .prepare(
          `UPDATE media SET ${sql ? sql + ", " : ""}updated_at = @now${tagsSql} WHERE id = @id`,
        )
        .run({
          ...params,
          now,
          id: existing.id,
          ...(input.tags ? { tags_json: toJson(input.tags) } : {}),
        });
      return { row: this.get(existing.id)!, created: false };
    }
    const cols: Record<string, unknown> = {
      station_id: this.stationId,
      path: input.path,
      status: input.status ?? "ok",
      tags_json: toJson(input.tags ?? {}),
      created_at: now,
      updated_at: now,
    };
    for (const key of MEDIA_WRITABLE) {
      if (input[key] !== undefined && key !== "status") cols[key] = input[key];
    }
    const names = Object.keys(cols);
    const info = this.db
      .prepare(
        `INSERT INTO media (${names.join(", ")}) VALUES (${names.map((n) => "@" + n).join(", ")})`,
      )
      .run(cols);
    return { row: this.get(Number(info.lastInsertRowid))!, created: true };
  }

  update(id: number, patch: Partial<MediaInput>): MediaRow | undefined {
    const p: Record<string, unknown> = { ...patch };
    delete p.path;
    const tags = p.tags as Record<string, unknown> | undefined;
    delete p.tags;
    const { sql, params } = buildSet(p, MEDIA_WRITABLE);
    const parts = [sql, tags ? "tags_json = @tags_json" : "", "updated_at = @now"].filter(Boolean);
    this.db
      .prepare(`UPDATE media SET ${parts.join(", ")} WHERE id = @id AND station_id = @sid`)
      .run({
        ...params,
        ...(tags ? { tags_json: toJson(tags) } : {}),
        now: nowIso(),
        id,
        sid: this.stationId,
      });
    return this.get(id);
  }

  setStatus(ids: number[], status: MediaStatus): number {
    if (ids.length === 0) return 0;
    return this.db
      .prepare(
        `UPDATE media SET status = ?, updated_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`,
      )
      .run(status, nowIso(), ...ids).changes;
  }

  /** Marks rows under `root` whose path was not seen in the latest scan as missing. */
  markMissingExcept(root: string, seenPaths: Set<string>): number {
    const rows = this.db
      .prepare(
        "SELECT id, path FROM media WHERE station_id = ? AND path LIKE ? AND status != 'missing'",
      )
      .all(this.stationId, `${root.replace(/[\\/]$/, "")}%`) as { id: number; path: string }[];
    const missing = rows.filter((r) => !seenPaths.has(r.path)).map((r) => r.id);
    return this.setStatus(missing, "missing");
  }

  delete(id: number): boolean {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM playlist_items WHERE media_id = ?").run(id);
      this.db.prepare("DELETE FROM metadata_suggestions WHERE media_id = ?").run(id);
      this.db.prepare("UPDATE plan_items SET media_id = NULL WHERE media_id = ?").run(id);
      this.db.prepare("UPDATE requests SET media_id = NULL WHERE media_id = ?").run(id);
      const hist = this.db
        .prepare("SELECT COUNT(*) AS n FROM play_history WHERE media_id = ?")
        .get(id) as Raw;
      if (Number(hist.n) > 0) {
        // Keep history intact: disable instead of delete.
        this.db
          .prepare("UPDATE media SET status = 'disabled', updated_at = ? WHERE id = ?")
          .run(nowIso(), id);
        return true;
      }
      return (
        this.db.prepare("DELETE FROM media WHERE id = ? AND station_id = ?").run(id, this.stationId)
          .changes > 0
      );
    });
    return tx();
  }

  search(query: MediaQuery = {}): { items: MediaRow[]; total: number } {
    const where: string[] = ["m.station_id = @sid"];
    const params: Record<string, unknown> = { sid: this.stationId };
    if (query.q) {
      where.push(
        "(m.title LIKE @q OR m.artist LIKE @q OR m.album LIKE @q OR m.relative_path LIKE @q)",
      );
      params.q = `%${query.q}%`;
    }
    for (const field of ["artist", "title", "album"] as const) {
      if (query[field]) {
        where.push(`m.${field} LIKE @${field}`);
        params[field] = `%${query[field]}%`;
      }
    }
    if (query.status) {
      where.push("m.status = @status");
      params.status = query.status;
    }
    if (query.minDuration !== undefined) {
      where.push("m.duration >= @minDuration");
      params.minDuration = query.minDuration;
    }
    if (query.maxDuration !== undefined) {
      where.push("m.duration <= @maxDuration");
      params.maxDuration = query.maxDuration;
    }
    if (query.minLufs !== undefined) {
      where.push("m.loudness_lufs >= @minLufs");
      params.minLufs = query.minLufs;
    }
    if (query.maxLufs !== undefined) {
      where.push("m.loudness_lufs <= @maxLufs");
      params.maxLufs = query.maxLufs;
    }
    if (query.duplicates) {
      where.push(
        "m.hash IS NOT NULL AND m.hash IN (SELECT hash FROM media WHERE station_id = @sid AND hash IS NOT NULL GROUP BY hash HAVING COUNT(*) > 1)",
      );
    }
    if (query.missingTags) {
      where.push("(m.title IS NULL OR m.title = '' OR m.artist IS NULL OR m.artist = '')");
    }
    if (query.playlistId !== undefined) {
      where.push("m.id IN (SELECT media_id FROM playlist_items WHERE playlist_id = @playlistId)");
      params.playlistId = query.playlistId;
    }
    if (query.pathPrefix) {
      where.push("(m.relative_path LIKE @pp OR m.path LIKE @pp)");
      params.pp = `${query.pathPrefix}%`;
    }
    const sortable = ["artist", "title", "album", "duration", "created_at", "loudness_lufs"];
    const sort = query.sort && sortable.includes(query.sort) ? query.sort : "artist";
    const order = query.order === "desc" ? "DESC" : "ASC";
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
    const offset = Math.max(query.offset ?? 0, 0);
    const whereSql = where.join(" AND ");
    const total = Number(
      (this.db.prepare(`SELECT COUNT(*) AS n FROM media m WHERE ${whereSql}`).get(params) as Raw).n,
    );
    const items = this.db
      .prepare(
        `SELECT m.* FROM media m WHERE ${whereSql} ORDER BY m.${sort} COLLATE NOCASE ${order}, m.id ASC LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit, offset })
      .map((r) => mapMedia(r as Raw)!);
    return { items, total };
  }

  /** Exact duplicates (same content hash) and near duplicates (normalized artist/title, ±2 s). */
  duplicateGroups(): { kind: "hash" | "metadata"; key: string; items: MediaRow[] }[] {
    const groups: { kind: "hash" | "metadata"; key: string; items: MediaRow[] }[] = [];
    const hashes = this.db
      .prepare(
        "SELECT hash FROM media WHERE station_id = ? AND hash IS NOT NULL AND status != 'disabled' GROUP BY hash HAVING COUNT(*) > 1",
      )
      .all(this.stationId) as { hash: string }[];
    const ignored = new Set(this.ignoredDuplicateKeys());
    for (const { hash } of hashes) {
      if (ignored.has(`hash:${hash}`)) continue;
      const items = this.db
        .prepare("SELECT * FROM media WHERE station_id = ? AND hash = ? ORDER BY id")
        .all(this.stationId, hash)
        .map((r) => mapMedia(r as Raw)!);
      groups.push({ kind: "hash", key: hash, items });
    }
    const rows = this.db
      .prepare(
        "SELECT * FROM media WHERE station_id = ? AND status != 'disabled' AND artist IS NOT NULL AND title IS NOT NULL",
      )
      .all(this.stationId)
      .map((r) => mapMedia(r as Raw)!);
    const byKey = new Map<string, MediaRow[]>();
    for (const row of rows) {
      const key = `${normalizeForMatch(row.artist ?? "")}|${normalizeForMatch(row.title ?? "")}`;
      const list = byKey.get(key) ?? [];
      list.push(row);
      byKey.set(key, list);
    }
    const hashGrouped = new Set(groups.flatMap((g) => g.items.map((i) => i.id)));
    for (const [key, list] of byKey) {
      if (list.length < 2 || ignored.has(`meta:${key}`)) continue;
      // Cluster by duration within ±2 s.
      list.sort((a, b) => (a.duration ?? 0) - (b.duration ?? 0));
      let cluster: MediaRow[] = [];
      const flush = () => {
        if (cluster.length > 1 && !cluster.every((c) => hashGrouped.has(c.id))) {
          groups.push({ kind: "metadata", key, items: cluster });
        }
        cluster = [];
      };
      for (const row of list) {
        const last = cluster[cluster.length - 1];
        if (last && Math.abs((row.duration ?? 0) - (last.duration ?? 0)) > 2) flush();
        cluster.push(row);
      }
      flush();
    }
    return groups;
  }

  ignoredDuplicateKeys(): string[] {
    const row = this.db
      .prepare("SELECT value_json FROM settings WHERE key = 'media.duplicates.ignored'")
      .get() as Raw | undefined;
    return fromJson<string[]>(row?.value_json as string | undefined, []);
  }

  ignoreDuplicateGroup(key: string): void {
    const keys = new Set(this.ignoredDuplicateKeys());
    keys.add(key);
    this.db
      .prepare(
        `INSERT INTO settings (station_id, key, value_json, updated_at) VALUES (?, 'media.duplicates.ignored', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(this.stationId, toJson([...keys]), nowIso());
  }

  /** Merge duplicates: keep `keepId`, re-point playlist/history references, disable the rest. */
  mergeDuplicates(keepId: number, removeIds: number[]): void {
    const tx = this.db.transaction(() => {
      for (const id of removeIds) {
        if (id === keepId) continue;
        this.db
          .prepare("UPDATE OR IGNORE playlist_items SET media_id = ? WHERE media_id = ?")
          .run(keepId, id);
        this.db.prepare("DELETE FROM playlist_items WHERE media_id = ?").run(id);
        this.db.prepare("UPDATE play_history SET media_id = ? WHERE media_id = ?").run(keepId, id);
        this.db.prepare("UPDATE plan_items SET media_id = ? WHERE media_id = ?").run(keepId, id);
        this.db
          .prepare("UPDATE media SET status = 'disabled', updated_at = ? WHERE id = ?")
          .run(nowIso(), id);
      }
    });
    tx();
  }

  count(): number {
    return Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS n FROM media WHERE station_id = ?")
          .get(this.stationId) as Raw
      ).n,
    );
  }

  stats(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM media WHERE station_id = ? GROUP BY status")
      .all(this.stationId) as { status: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }

  needsLoudness(limit = 50): MediaRow[] {
    return this.db
      .prepare(
        "SELECT * FROM media WHERE station_id = ? AND status = 'ok' AND loudness_lufs IS NULL ORDER BY id LIMIT ?",
      )
      .all(this.stationId, limit)
      .map((r) => mapMedia(r as Raw)!);
  }

  /** Every row that already has a loudness envelope (recompute cue points from it). */
  allWithEnvelope(): MediaRow[] {
    return this.db
      .prepare(
        "SELECT * FROM media WHERE station_id = ? AND status = 'ok' AND loudness_envelope IS NOT NULL ORDER BY id",
      )
      .all(this.stationId)
      .map((r) => mapMedia(r as Raw)!);
  }

  /** Rows whose cue points have never been analysed (loudness exists, envelope missing). */
  needsAutocue(limit = 50): MediaRow[] {
    return this.db
      .prepare(
        "SELECT * FROM media WHERE station_id = ? AND status = 'ok' AND loudness_lufs IS NOT NULL AND loudness_envelope IS NULL ORDER BY id LIMIT ?",
      )
      .all(this.stationId, limit)
      .map((r) => mapMedia(r as Raw)!);
  }

  addSuggestion(mediaId: number, source: string, payload: unknown): number {
    const info = this.db
      .prepare(
        "INSERT INTO metadata_suggestions (media_id, source, payload_json, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
      )
      .run(mediaId, source, toJson(payload), nowIso());
    return Number(info.lastInsertRowid);
  }

  listSuggestions(status = "pending"): {
    id: number;
    media_id: number;
    source: string;
    payload: Record<string, unknown>;
    status: string;
    created_at: string;
  }[] {
    return (
      this.db
        .prepare(
          "SELECT s.* FROM metadata_suggestions s JOIN media m ON m.id = s.media_id WHERE m.station_id = ? AND s.status = ? ORDER BY s.id DESC",
        )
        .all(this.stationId, status) as Raw[]
    ).map((r) => ({
      id: Number(r.id),
      media_id: Number(r.media_id),
      source: String(r.source),
      payload: fromJson(r.payload_json as string, {}),
      status: String(r.status),
      created_at: String(r.created_at),
    }));
  }

  getSuggestion(
    id: number,
  ):
    { id: number; media_id: number; payload: Record<string, unknown>; status: string } | undefined {
    const r = this.db.prepare("SELECT * FROM metadata_suggestions WHERE id = ?").get(id) as
      Raw | undefined;
    if (!r) return undefined;
    return {
      id: Number(r.id),
      media_id: Number(r.media_id),
      payload: fromJson(r.payload_json as string, {}),
      status: String(r.status),
    };
  }

  resolveSuggestion(id: number, status: "applied" | "rejected"): void {
    this.db
      .prepare("UPDATE metadata_suggestions SET status = ?, applied_at = ? WHERE id = ?")
      .run(status, status === "applied" ? nowIso() : null, id);
  }
}

export function normalizeForMatch(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, "")
    .replace(/\b(feat|ft|featuring)\b.*$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function mapPlaylist(row: Raw | undefined): PlaylistRow | undefined {
  if (!row) return undefined;
  return {
    ...(row as unknown as PlaylistRow),
    is_jingle: bool(row.is_jingle),
    enabled: bool(row.enabled),
    ...(row.item_count !== undefined ? { item_count: Number(row.item_count) } : {}),
  };
}

export class PlaylistRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly stationId: number,
  ) {}

  list(): PlaylistRow[] {
    return this.db
      .prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.id) AS item_count
         FROM playlists p WHERE p.station_id = ? ORDER BY p.sort_order, p.name`,
      )
      .all(this.stationId)
      .map((r) => mapPlaylist(r as Raw)!);
  }

  get(id: number): PlaylistRow | undefined {
    return mapPlaylist(
      this.db
        .prepare("SELECT * FROM playlists WHERE id = ? AND station_id = ?")
        .get(id, this.stationId) as Raw,
    );
  }

  getByName(name: string): PlaylistRow | undefined {
    return mapPlaylist(
      this.db
        .prepare("SELECT * FROM playlists WHERE name = ? AND station_id = ?")
        .get(name, this.stationId) as Raw,
    );
  }

  /** Roles of the playlists this media is in (news bulletins, jingles, music). */
  rolesForMedia(mediaId: number): PlaylistRole[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT p.role FROM playlist_items i JOIN playlists p ON p.id = i.playlist_id
           WHERE i.media_id = ? AND p.station_id = ?`,
        )
        .all(mediaId, this.stationId) as { role: PlaylistRole }[]
    ).map((r) => r.role);
  }

  create(input: {
    name: string;
    role: PlaylistRole;
    prefix?: string | null;
    rotation?: string | null;
    weight?: number;
    isJingle?: boolean;
    enabled?: boolean;
    sortOrder?: number;
  }): PlaylistRow {
    const now = nowIso();
    const info = this.db
      .prepare(
        `INSERT INTO playlists (station_id, name, role, prefix, rotation, weight, is_jingle, enabled, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.stationId,
        input.name,
        input.role,
        input.prefix ?? null,
        input.rotation ?? "default",
        input.weight ?? 1,
        input.isJingle ? 1 : 0,
        input.enabled === false ? 0 : 1,
        input.sortOrder ?? 0,
        now,
        now,
      );
    return this.get(Number(info.lastInsertRowid))!;
  }

  update(
    id: number,
    patch: Partial<{
      name: string;
      role: PlaylistRole;
      prefix: string | null;
      rotation: string | null;
      weight: number;
      is_jingle: boolean;
      enabled: boolean;
      sort_order: number;
    }>,
  ): PlaylistRow | undefined {
    const { sql, params } = buildSet(patch, [
      "name",
      "role",
      "prefix",
      "rotation",
      "weight",
      "is_jingle",
      "enabled",
      "sort_order",
    ]);
    if (sql) {
      this.db
        .prepare(
          `UPDATE playlists SET ${sql}, updated_at = @now WHERE id = @id AND station_id = @sid`,
        )
        .run({ ...params, now: nowIso(), id, sid: this.stationId });
    }
    return this.get(id);
  }

  delete(id: number): boolean {
    const used = this.db
      .prepare("SELECT COUNT(*) AS n FROM schedule_slots WHERE playlist_id = ?")
      .get(id) as Raw;
    if (Number(used.n) > 0) throw new Error("playlist is used by a schedule slot");
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM playlist_items WHERE playlist_id = ?").run(id);
      this.db.prepare("UPDATE plan_items SET playlist_id = NULL WHERE playlist_id = ?").run(id);
      this.db.prepare("UPDATE events SET playlist_id = NULL WHERE playlist_id = ?").run(id);
      return (
        this.db
          .prepare("DELETE FROM playlists WHERE id = ? AND station_id = ?")
          .run(id, this.stationId).changes > 0
      );
    });
    return tx();
  }

  items(playlistId: number): (PlaylistItemRow & { media: MediaRow })[] {
    const rows = this.db
      .prepare(
        `SELECT i.id AS item_id, i.playlist_id, i.media_id, i.weight AS item_weight, i.position, m.*
         FROM playlist_items i JOIN media m ON m.id = i.media_id
         WHERE i.playlist_id = ? ORDER BY i.position, i.id`,
      )
      .all(playlistId) as Raw[];
    return rows.map((r) => ({
      id: Number(r.item_id),
      playlist_id: Number(r.playlist_id),
      media_id: Number(r.media_id),
      weight: Number(r.item_weight),
      position: Number(r.position),
      media: mapMedia({ ...r, id: r.media_id })!,
    }));
  }

  replaceItems(playlistId: number, items: { mediaId: number; weight?: number }[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM playlist_items WHERE playlist_id = ?").run(playlistId);
      const ins = this.db.prepare(
        "INSERT OR IGNORE INTO playlist_items (playlist_id, media_id, weight, position) VALUES (?, ?, ?, ?)",
      );
      items.forEach((item, index) => ins.run(playlistId, item.mediaId, item.weight ?? 1, index));
      this.db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(nowIso(), playlistId);
    });
    tx();
  }

  addItems(playlistId: number, mediaIds: number[]): number {
    const max = this.db
      .prepare("SELECT COALESCE(MAX(position), -1) AS p FROM playlist_items WHERE playlist_id = ?")
      .get(playlistId) as Raw;
    let pos = Number(max.p) + 1;
    const ins = this.db.prepare(
      "INSERT OR IGNORE INTO playlist_items (playlist_id, media_id, weight, position) VALUES (?, ?, 1, ?)",
    );
    let added = 0;
    const tx = this.db.transaction(() => {
      for (const id of mediaIds) added += ins.run(playlistId, id, pos++).changes;
    });
    tx();
    return added;
  }

  removeItem(playlistId: number, mediaId: number): boolean {
    return (
      this.db
        .prepare("DELETE FROM playlist_items WHERE playlist_id = ? AND media_id = ?")
        .run(playlistId, mediaId).changes > 0
    );
  }

  reorder(playlistId: number, mediaIds: number[]): void {
    const upd = this.db.prepare(
      "UPDATE playlist_items SET position = ? WHERE playlist_id = ? AND media_id = ?",
    );
    const tx = this.db.transaction(() => mediaIds.forEach((id, i) => upd.run(i, playlistId, id)));
    tx();
  }

  /** Candidate pool for the generator: enabled ok media in the given playlists. */
  pool(playlistIds: number[]): { media: MediaRow; playlistId: number; weight: number }[] {
    if (playlistIds.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT i.playlist_id AS pl_id, i.weight AS item_weight, m.* FROM playlist_items i
         JOIN media m ON m.id = i.media_id
         WHERE i.playlist_id IN (${playlistIds.map(() => "?").join(",")}) AND m.status = 'ok' AND m.duration > 0
         ORDER BY i.playlist_id, i.position, i.id`,
      )
      .all(...playlistIds) as Raw[];
    return rows.map((r) => ({
      media: mapMedia(r)!,
      playlistId: Number(r.pl_id),
      weight: Number(r.item_weight),
    }));
  }
}
