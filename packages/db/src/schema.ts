/**
 * Station database schema (PLAN §6.3 + `generator_runs` from §7.1) — PLAN M1.2.
 *
 * Conventions agreed with ADR 0005 (better-sqlite3 + WAL, one writer):
 *   - Every table: `id INTEGER PRIMARY KEY AUTOINCREMENT` (SQLite's identity).
 *   - Every station-owned table carries `station_id` FK → `stations.id` (default 1)
 *     so all future queries can be station-scoped at the SQL level.
 *   - Dates/times are ISO-8601 **UTC** text (`2026-11-22T16:24:52Z`): lexicographic
 *     sort == chronological sort, DST-safe, and the station wall clock
 *     (Europe/Amsterdam) is derived at render time, never stored.
 *   - `*_json` columns hold serialized JSON as text (SQLite has no JSON type).
 *   - Booleans are `integer` 0/1 — SQLite has no boolean type (SQLite renders
 *     `true` as 1 anyway, so the wire format matches `is_active === 1` checks).
 *   - CHECK constraints follow §6.3 verbatim; they run on **unqualified** names,
 *     because a qualified `"table"."col"` reference inside a CHECK is illegal in
 *     SQLite when the constraint is checked outside INSERT scope.
 *
 * The generated migrations live in `packages/db/drizzle/` (drizzle-kit, dialect
 * `sqlite`); the runtime applies them through `drizzle-orm/better-sqlite3/migrator`.
 */
import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// Core station and auth
// ---------------------------------------------------------------------------

export const stations = sqliteTable("stations", {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  timezone: text().notNull(),
  locale: text().notNull(),
  logo_url: text(),
  colors_json: text().notNull(),
  created_at: text().notNull(),
  updated_at: text().notNull(),
});

export const users = sqliteTable(
  "users",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    station_id: integer()
      .notNull()
      .references(() => stations.id)
      .default(1),
    username: text().notNull().unique("uniq_users_username"),
    email: text().notNull().unique("uniq_users_email"),
    password_hash: text().notNull(),
    role: text().notNull(),
    totp_secret: text(),
    totp_enabled: integer().notNull().default(0),
    is_active: integer().notNull().default(0),
    last_login_at: text(),
    created_at: text().notNull(),
    updated_at: text().notNull(),
  },
  (_t) => [check("users_role", sql.raw(`role IN ('admin', 'dj', 'operator')`))],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    user_id: integer()
      .notNull()
      .references(() => users.id),
    token_hash: text().notNull().unique("uniq_sessions_token_hash"),
    ip: text().notNull(),
    user_agent: text(),
    expires_at: text().notNull(),
    created_at: text().notNull(),
    revoked_at: text(),
  },
  (t) => [index("sessions_user_expires_at").on(t.user_id, t.expires_at)],
);

/**
 * Mobile / remote-control app access (bearer tokens). One row per paired
 * device: a short-lived access token and a rotating refresh token (both
 * SHA-256 hashed). `prev_refresh_hash` detects refresh-token reuse (theft): the
 * grant is revoked. A row can start as a pending pairing (code from the web
 * console) before the app exchanges it for tokens.
 */
export const device_grants = sqliteTable(
  "device_grants",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    user_id: integer()
      .notNull()
      .references(() => users.id),
    name: text().notNull(),
    platform: text(),
    app_version: text(),
    access_hash: text().unique("uniq_device_grants_access_hash"),
    access_expires_at: text(),
    refresh_hash: text().unique("uniq_device_grants_refresh_hash"),
    prev_refresh_hash: text(),
    refresh_expires_at: text(),
    pairing_hash: text().unique("uniq_device_grants_pairing_hash"),
    pairing_expires_at: text(),
    created_ip: text(),
    last_ip: text(),
    last_used_at: text(),
    created_at: text().notNull(),
    revoked_at: text(),
    revoked_reason: text(),
  },
  (t) => [
    index("device_grants_user").on(t.user_id, t.revoked_at),
    index("device_grants_prev_refresh").on(t.prev_refresh_hash),
  ],
);

export const password_resets = sqliteTable("password_resets", {
  id: integer().primaryKey({ autoIncrement: true }),
  user_id: integer()
    .notNull()
    .references(() => users.id),
  token_hash: text().notNull().unique("uniq_password_resets_token_hash"),
  expires_at: text().notNull(),
  used_at: text(),
  created_at: text().notNull(),
});

export const api_keys = sqliteTable("api_keys", {
  id: integer().primaryKey({ autoIncrement: true }),
  station_id: integer()
    .notNull()
    .references(() => stations.id)
    .default(1),
  name: text().notNull(),
  key_prefix: text().notNull(),
  key_hash: text().notNull().unique("uniq_api_keys_key_hash"),
  scopes_json: text().notNull(),
  created_by: integer().references(() => users.id),
  last_used_at: text(),
  revoked_at: text(),
  created_at: text().notNull(),
});

export const audit_log = sqliteTable(
  "audit_log",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    station_id: integer()
      .notNull()
      .references(() => stations.id)
      .default(1),
    user_id: integer().references(() => users.id),
    action: text().notNull(),
    entity_type: text(),
    entity_id: integer(),
    metadata_json: text(),
    ip: text(),
    created_at: text().notNull(),
  },
  (t) => [
    index("audit_log_station_created_at").on(t.station_id, t.created_at),
    index("audit_log_entity").on(t.entity_type, t.entity_id),
  ],
);

// ---------------------------------------------------------------------------
// Media and playlists
// ---------------------------------------------------------------------------

export const media = sqliteTable(
  "media",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    station_id: integer()
      .notNull()
      .references(() => stations.id)
      .default(1),
    path: text().notNull().unique("uniq_media_path"),
    relative_path: text(),
    title: text(),
    artist: text(),
    artist_sort: text(),
    album: text(),
    album_artist: text(),
    genre: text(),
    year: integer(),
    duration: real(),
    sample_rate: integer(),
    channels: integer(),
    bitrate: integer(),
    codec: text(),
    loudness_lufs: real(),
    peak_db: real(),
    gain_db: real(),
    cue_in: real(),
    cue_out: real(),
    /** File time (seconds) where the intro ends / vocals start (studio intro timer). */
    intro_end: real(),
    /** File time (seconds) where the outro starts (studio outro timer). */
    outro_start: real(),
    fade_in: real(),
    fade_out: real(),
    /** Last automatic cue result (JSON) from the loudness analysis. */
    autocue_json: text(),
    /** Momentary loudness envelope every 100 ms (base64; see @radio/core). */
    loudness_envelope: text(),
    /** 'auto' lets analysis set the cue/fade points; 'manual' keeps the user's values. */
    cue_source: text().default("auto"),
    artwork_path: text(),
    hash: text(),
    size: integer(),
    mtime: text(),
    status: text().notNull(),
    tags_json: text(),
    created_at: text().notNull(),
    updated_at: text().notNull(),
  },
  (t) => [
    check(
      "media_status",
      sql.raw(`status IN ('ok', 'missing', 'processing', 'error', 'disabled')`),
    ),
    index("media_station_artist").on(t.station_id, t.artist),
    index("media_station_title").on(t.station_id, t.title),
  ],
);

export const playlists = sqliteTable(
  "playlists",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    station_id: integer()
      .notNull()
      .references(() => stations.id)
      .default(1),
    name: text().notNull().unique("uniq_playlists_name"),
    role: text().notNull(),
    prefix: text(),
    rotation: text(),
    weight: real().notNull().default(1),
    is_jingle: integer().notNull().default(0),
    enabled: integer().notNull().default(1),
    sort_order: integer().notNull().default(0),
    created_at: text().notNull(),
    updated_at: text().notNull(),
  },
  (_t) => [
    check("playlists_role", sql.raw(`role IN ('music', 'news', 'jingle', 'general', 'decade')`)),
  ],
);

export const playlist_items = sqliteTable(
  "playlist_items",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    playlist_id: integer()
      .notNull()
      .references(() => playlists.id),
    media_id: integer()
      .notNull()
      .references(() => media.id),
    weight: real().notNull().default(1),
    position: integer().notNull().default(0),
  },
  (t) => [
    unique("uniq_playlist_items_media").on(t.playlist_id, t.media_id),
    index("playlist_items_playlist_position").on(t.playlist_id, t.position),
  ],
);

export const metadata_suggestions = sqliteTable("metadata_suggestions", {
  id: integer().primaryKey({ autoIncrement: true }),
  media_id: integer()
    .notNull()
    .references(() => media.id),
  source: text().notNull(),
  payload_json: text().notNull(),
  status: text().notNull(),
  created_at: text().notNull(),
  applied_at: text(),
});

// ---------------------------------------------------------------------------
// Schedule and plans
// ---------------------------------------------------------------------------

export const schedule_slots = sqliteTable(
  "schedule_slots",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    station_id: integer()
      .notNull()
      .references(() => stations.id)
      .default(1),
    hour: integer().notNull(),
    playlist_id: integer()
      .notNull()
      .references(() => playlists.id),
    start_time: text(),
    end_time: text(),
    days_json: text().notNull(),
    start_date: text().notNull(),
    end_date: text(),
    loop_once: integer().notNull().default(0),
    priority: integer().notNull().default(0),
    enabled: integer().notNull().default(1),
    created_at: text().notNull(),
    updated_at: text().notNull(),
  },
  (t) => [
    check("schedule_slots_hour", sql.raw(`hour >= 0 AND hour <= 23`)),
    unique("uniq_schedule_slots_slot").on(t.station_id, t.hour, t.start_date),
    index("schedule_slots_station_hour").on(t.station_id, t.hour),
  ],
);

export const hourly_plans = sqliteTable(
  "hourly_plans",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    station_id: integer()
      .notNull()
      .references(() => stations.id)
      .default(1),
    plan_date: text().notNull(),
    hour: integer().notNull(),
    status: text().notNull(),
    generated_at: text(),
    total_seconds: real(),
    warnings_json: text(),
    snapshot_json: text(),
  },
  (t) => [
    check(
      "hourly_plans_status",
      sql.raw(`status IN ('draft', 'ready', 'on_air', 'done', 'failed')`),
    ),
    check("hourly_plans_hour", sql.raw(`hour >= 0 AND hour <= 23`)),
    unique("uniq_hourly_plans_plan").on(t.station_id, t.plan_date, t.hour),
  ],
);

export const plan_items = sqliteTable(
  "plan_items",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    plan_id: integer()
      .notNull()
      .references(() => hourly_plans.id),
    position: integer().notNull(),
    media_id: integer().references(() => media.id),
    kind: text().notNull(),
    start_seconds: real().notNull().default(0),
    length: real().notNull().default(0),
    playlist_id: integer().references(() => playlists.id),
    artist: text(),
    title: text(),
    is_locked: integer().notNull().default(0),
  },
  (t) => [
    check("plan_items_kind", sql.raw(`kind IN ('music', 'news', 'jingle', 'live')`)),
    index("plan_items_plan_position").on(t.plan_id, t.position),
  ],
);

export const boundary_events = sqliteTable(
  "boundary_events",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    station_id: integer()
      .notNull()
      .references(() => stations.id)
      .default(1),
    plan_id: integer()
      .notNull()
      .references(() => hourly_plans.id),
    occurred_at: text().notNull(),
    boundary_at: text().notNull(),
    action: text().notNull(),
    deviation_ms: integer().notNull().default(0),
    details_json: text(),
  },
  (t) => [
    check(
      "boundary_events_action",
      sql.raw(`action IN ('cut', 'let_finish', 'early_news', 'late_news', 'none')`),
    ),
    index("boundary_events_station_occurred_at").on(t.station_id, t.occurred_at),
  ],
);

export const schedule_settings = sqliteTable(
  "schedule_settings",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    station_id: integer()
      .notNull()
      .references(() => stations.id)
      .default(1),
    key: text().notNull(),
    value_json: text().notNull(),
    updated_at: text().notNull(),
  },
  (t) => [unique("uniq_schedule_settings_key").on(t.station_id, t.key)],
);

// ---------------------------------------------------------------------------
// Live, events, requests
// ---------------------------------------------------------------------------

export const live_sessions = sqliteTable(
  "live_sessions",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    station_id: integer()
      .notNull()
      .references(() => stations.id)
      .default(1),
    user_id: integer().references(() => users.id),
    mode: text().notNull(),
    started_at: text().notNull(),
    ended_at: text(),
    duration: real(),
    recorded_path: text(),
    recorded_size: integer(),
    peak_listeners: integer(),
    notes: text(),
    created_at: text().notNull(),
  },
  (t) => [
    check("live_sessions_mode", sql.raw(`mode IN ('duck', 'takeover')`)),
    index("live_sessions_station_started_at").on(t.station_id, t.started_at),
  ],
);

export const events = sqliteTable(
  "events",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    station_id: integer()
      .notNull()
      .references(() => stations.id)
      .default(1),
    title: text().notNull(),
    type: text().notNull(),
    start_at: text().notNull(),
    end_at: text(),
    priority: integer().notNull().default(0),
    playlist_id: integer().references(() => playlists.id),
    status: text().notNull(),
    created_by: integer().references(() => users.id),
    created_at: text().notNull(),
    ended_at: text(),
  },
  (t) => [
    check("events_type", sql.raw(`type IN ('playlist', 'live', 'stinger')`)),
    index("events_station_start_at").on(t.station_id, t.start_at),
  ],
);

export const requests = sqliteTable(
  "requests",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    station_id: integer()
      .notNull()
      .references(() => stations.id)
      .default(1),
    listener_ip: text().notNull(),
    display_name: text(),
    contact: text(),
    artist: text(),
    title: text(),
    message: text(),
    dedication: text(),
    media_id: integer().references(() => media.id),
    status: text().notNull(),
    moderated_by: integer().references(() => users.id),
    moderated_at: text(),
    play_after: integer().notNull().default(0),
    created_at: text().notNull(),
    played_at: text(),
  },
  (t) => [
    check(
      "requests_status",
      sql.raw(`status IN ('pending', 'approved', 'rejected', 'played', 'expired')`),
    ),
    index("requests_station_status_created_at").on(t.station_id, t.status, t.created_at),
  ],
);

export const request_rate_limits = sqliteTable(
  "request_rate_limits",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    station_id: integer()
      .notNull()
      .references(() => stations.id)
      .default(1),
    ip: text().notNull(),
    window_start: text().notNull(),
    count: integer().notNull().default(0),
  },
  (t) => [unique("uniq_request_rate_limits_window").on(t.station_id, t.ip, t.window_start)],
);

export const request_blacklist = sqliteTable(
  "request_blacklist",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    station_id: integer()
      .notNull()
      .references(() => stations.id)
      .default(1),
    pattern: text().notNull(),
    match_type: text().notNull(),
    created_by: integer().references(() => users.id),
    created_at: text().notNull(),
  },
  (t) => [index("request_blacklist_pattern").on(t.pattern)],
);

// ---------------------------------------------------------------------------
// History, stats, alerts, settings
// ---------------------------------------------------------------------------

export const play_history = sqliteTable(
  "play_history",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    station_id: integer()
      .notNull()
      .references(() => stations.id)
      .default(1),
    media_id: integer()
      .notNull()
      .references(() => media.id),
    plan_id: integer().references(() => hourly_plans.id),
    started_at: text().notNull(),
    ended_at: text(),
    source: text().notNull(),
    listeners_peak: integer(),
    created_at: text().notNull(),
  },
  (t) => [
    check(
      "play_history_source",
      sql.raw(`source IN ('automation', 'live', 'event', 'request', 'manual')`),
    ),
    index("play_history_station_started_at").on(t.station_id, t.started_at),
  ],
);

export const listener_stats = sqliteTable(
  "listener_stats",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    station_id: integer()
      .notNull()
      .references(() => stations.id)
      .default(1),
    ts: text().notNull(),
    mount: text().notNull(),
    listeners: integer().notNull().default(0),
  },
  (t) => [index("listener_stats_station_ts_mount").on(t.station_id, t.ts, t.mount)],
);

export const alerts = sqliteTable(
  "alerts",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    station_id: integer()
      .notNull()
      .references(() => stations.id)
      .default(1),
    type: text().notNull(),
    severity: text().notNull(),
    message: text().notNull(),
    details_json: text(),
    created_at: text().notNull(),
    acknowledged_at: text(),
    acknowledged_by: integer().references(() => users.id),
    resolved_at: text(),
  },
  (t) => [
    index("alerts_station_created_at").on(t.station_id, t.created_at),
    index("alerts_station_type").on(t.station_id, t.type),
  ],
);

export const settings = sqliteTable("settings", {
  id: integer().primaryKey({ autoIncrement: true }),
  station_id: integer()
    .notNull()
    .references(() => stations.id)
    .default(1),
  key: text().notNull().unique("uniq_settings_key"),
  value_json: text().notNull(),
  updated_at: text().notNull(),
});

export const backups = sqliteTable("backups", {
  id: integer().primaryKey({ autoIncrement: true }),
  path: text().notNull(),
  type: text().notNull(),
  size: integer().notNull().default(0),
  created_at: text().notNull(),
  verified_at: text(),
});

// ---------------------------------------------------------------------------
// Generator runs (§7.1 "Add table")
// ---------------------------------------------------------------------------

export const generator_runs = sqliteTable(
  "generator_runs",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    station_id: integer()
      .notNull()
      .references(() => stations.id)
      .default(1),
    run_type: text().notNull(),
    started_at: text().notNull(),
    finished_at: text(),
    mode: text(),
    hours_json: text(),
    status: text().notNull(),
    warnings_json: text(),
    error: text(),
  },
  (t) => [index("generator_runs_station_started_at").on(t.station_id, t.started_at)],
);

/** Every table this schema owns — used by tests and the migrate CLI. */
export const SCHEMA_TABLE_NAMES = [
  "alerts",
  "api_keys",
  "audit_log",
  "backups",
  "boundary_events",
  "device_grants",
  "events",
  "generator_runs",
  "hourly_plans",
  "listener_stats",
  "live_sessions",
  "media",
  "metadata_suggestions",
  "password_resets",
  "plan_items",
  "playlist_items",
  "play_history",
  "playlists",
  "request_blacklist",
  "request_rate_limits",
  "requests",
  "schedule_settings",
  "schedule_slots",
  "sessions",
  "settings",
  "stations",
  "users",
];
