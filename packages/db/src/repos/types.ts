/** Row types (snake_case, as stored). JSON columns are parsed by the repositories. */
import type { Role } from "@radio/shared";

export interface StationRow {
  id: number;
  name: string;
  timezone: string;
  locale: string;
  logo_url: string | null;
  colors: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface UserRow {
  id: number;
  station_id: number;
  username: string;
  email: string;
  password_hash: string;
  role: Role;
  totp_secret: string | null;
  totp_enabled: boolean;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export type PublicUser = Omit<UserRow, "password_hash" | "totp_secret">;

export interface SessionRow {
  id: number;
  user_id: number;
  token_hash: string;
  ip: string;
  user_agent: string | null;
  expires_at: string;
  created_at: string;
  revoked_at: string | null;
}

export interface DeviceGrantRow {
  id: number;
  user_id: number;
  name: string;
  platform: string | null;
  app_version: string | null;
  access_hash: string | null;
  access_expires_at: string | null;
  refresh_hash: string | null;
  prev_refresh_hash: string | null;
  refresh_expires_at: string | null;
  pairing_hash: string | null;
  pairing_expires_at: string | null;
  created_ip: string | null;
  last_ip: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
}

export interface ApiKeyRow {
  id: number;
  station_id: number;
  name: string;
  key_prefix: string;
  key_hash: string;
  scopes: string[];
  created_by: number | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface AuditRow {
  id: number;
  station_id: number;
  user_id: number | null;
  username?: string | null;
  action: string;
  entity_type: string | null;
  entity_id: number | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  created_at: string;
}

export type MediaStatus = "ok" | "missing" | "processing" | "error" | "disabled";

export interface MediaRow {
  id: number;
  station_id: number;
  path: string;
  relative_path: string | null;
  title: string | null;
  artist: string | null;
  artist_sort: string | null;
  album: string | null;
  album_artist: string | null;
  genre: string | null;
  year: number | null;
  duration: number | null;
  sample_rate: number | null;
  channels: number | null;
  bitrate: number | null;
  codec: string | null;
  loudness_lufs: number | null;
  peak_db: number | null;
  gain_db: number | null;
  cue_in: number | null;
  cue_out: number | null;
  fade_in: number | null;
  fade_out: number | null;
  artwork_path: string | null;
  hash: string | null;
  size: number | null;
  mtime: string | null;
  status: MediaStatus;
  tags: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type PlaylistRole = "music" | "news" | "jingle" | "general" | "decade";

export interface PlaylistRow {
  id: number;
  station_id: number;
  name: string;
  role: PlaylistRole;
  prefix: string | null;
  rotation: string | null;
  weight: number;
  is_jingle: boolean;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  item_count?: number;
}

export interface PlaylistItemRow {
  id: number;
  playlist_id: number;
  media_id: number;
  weight: number;
  position: number;
}

export interface ScheduleSlotRow {
  id: number;
  station_id: number;
  hour: number;
  playlist_id: number;
  playlist_name?: string;
  start_time: string | null;
  end_time: string | null;
  days: number[];
  start_date: string;
  end_date: string | null;
  loop_once: boolean;
  priority: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export type PlanStatus = "draft" | "ready" | "on_air" | "done" | "failed";

export interface HourlyPlanRow {
  id: number;
  station_id: number;
  plan_date: string;
  hour: number;
  status: PlanStatus;
  generated_at: string | null;
  total_seconds: number | null;
  warnings: string[];
  snapshot: unknown;
}

export interface PlanItemRow {
  id: number;
  plan_id: number;
  position: number;
  media_id: number | null;
  kind: "music" | "news" | "jingle" | "live";
  start_seconds: number;
  length: number;
  playlist_id: number | null;
  artist: string | null;
  title: string | null;
  is_locked: boolean;
}

export interface RequestRow {
  id: number;
  station_id: number;
  listener_ip: string;
  display_name: string | null;
  contact: string | null;
  artist: string | null;
  title: string | null;
  message: string | null;
  dedication: string | null;
  media_id: number | null;
  status: "pending" | "approved" | "rejected" | "played" | "expired";
  moderated_by: number | null;
  moderated_at: string | null;
  play_after: number;
  created_at: string;
  played_at: string | null;
}

export interface AlertRow {
  id: number;
  station_id: number;
  type: string;
  severity: "info" | "warning" | "error" | "critical";
  message: string;
  details: Record<string, unknown> | null;
  created_at: string;
  acknowledged_at: string | null;
  acknowledged_by: number | null;
  resolved_at: string | null;
}

export interface EventRow {
  id: number;
  station_id: number;
  title: string;
  type: "playlist" | "live" | "stinger";
  start_at: string;
  end_at: string | null;
  priority: number;
  playlist_id: number | null;
  status: string;
  created_by: number | null;
  created_at: string;
  ended_at: string | null;
}

export interface LiveSessionRow {
  id: number;
  station_id: number;
  user_id: number | null;
  username?: string | null;
  mode: "duck" | "takeover";
  started_at: string;
  ended_at: string | null;
  duration: number | null;
  recorded_path: string | null;
  recorded_size: number | null;
  peak_listeners: number | null;
  notes: string | null;
  created_at: string;
}

export interface PlayHistoryRow {
  id: number;
  station_id: number;
  media_id: number;
  plan_id: number | null;
  started_at: string;
  ended_at: string | null;
  source: "automation" | "live" | "event" | "request" | "manual";
  listeners_peak: number | null;
  created_at: string;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  duration?: number | null;
  artwork_path?: string | null;
}
