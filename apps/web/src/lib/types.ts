/** Wire types (mirrors @radio/shared protocol + DB rows; kept local so the web bundle stays lean). */

export type Role = "admin" | "dj" | "operator";
export type Permission =
  | "playout:view"
  | "playout:control"
  | "live:broadcast"
  | "live:manage"
  | "media:view"
  | "media:manage"
  | "playlists:manage"
  | "schedule:view"
  | "schedule:manage"
  | "requests:moderate"
  | "events:manage"
  | "stats:view"
  | "alerts:view"
  | "alerts:ack"
  | "users:manage"
  | "settings:view"
  | "settings:manage"
  | "apikeys:manage"
  | "audit:view"
  | "recordings:manage";

const OPERATOR: Permission[] = [
  "playout:view",
  "playout:control",
  "live:manage",
  "media:view",
  "media:manage",
  "playlists:manage",
  "schedule:view",
  "schedule:manage",
  "requests:moderate",
  "events:manage",
  "stats:view",
  "alerts:view",
  "alerts:ack",
  "recordings:manage",
];
const DJ: Permission[] = [
  "playout:view",
  "playout:control",
  "live:broadcast",
  "media:view",
  "schedule:view",
  "requests:moderate",
  "stats:view",
  "alerts:view",
];
export function can(role: Role | undefined, p: Permission): boolean {
  if (!role) return false;
  if (role === "admin") return true;
  return (role === "operator" ? OPERATOR : DJ).includes(p);
}

export interface User {
  id: number;
  username: string;
  email: string;
  role: Role;
  totp_enabled: boolean;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
}

export interface QueueItem {
  uid: string;
  kind: "music" | "news" | "jingle" | "live" | "request" | "stinger" | "voiceover" | "emergency";
  mediaId: number | null;
  title: string;
  artist: string;
  duration: number;
  plannedStart: number | null;
  locked: boolean;
  source: "automation" | "request" | "manual" | "event" | "live";
  requestId: number | null;
  artworkUrl: string | null;
}

export interface NowPlaying extends QueueItem {
  startedAt: number;
  position: number;
}

export interface EncoderStatus {
  mount: string;
  codec: string;
  bitrate: string;
  running: boolean;
  restarts: number;
  uptimeSeconds: number;
  queuedMs: number;
  lastError: string | null;
}

export interface BoundaryEntry {
  at: number;
  boundaryAt: number;
  action: "cut" | "let_finish" | "early_news" | "late_news" | "none";
  deviationMs: number;
  details: Record<string, unknown>;
}

export interface LiveStatus {
  active: boolean;
  mode: "duck" | "takeover";
  source: string | null;
  userId: number | null;
  sessionId: number | null;
  startedAt: number | null;
  recording: boolean;
  gainDb: number;
  inputPeakDb: number;
}

export interface PlayoutState {
  mode: "idle" | "autoplay" | "live" | "event" | "interrupt" | "emergency";
  paused: boolean;
  stopped: boolean;
  nowPlaying: NowPlaying | null;
  queue: QueueItem[];
  history: QueueItem[];
  fader: number;
  monitor: boolean;
  voiceOver: { active: boolean; title: string | null };
  event: { active: boolean; id: number | null; title: string | null; priority: number };
  live: LiveStatus;
  emergency: { active: boolean; reason: string | null; since: number | null };
  encoders: EncoderStatus[];
  stereotool: {
    enabled: boolean;
    running: boolean;
    bypassed: boolean;
    mode: string;
    edition: string | null;
    restarts: number;
    error: string | null;
  };
  boundaryLog: BoundaryEntry[];
  currentPlan: { planId: number | null; date: string | null; hour: number | null };
  uptimeSeconds: number;
}

export interface Meter {
  masterPeak: number;
  masterRms: number;
  buses: { name: string; peak: number; rms: number; gain: number }[];
  duckGain: number;
}

export interface Media {
  id: number;
  path: string;
  relative_path: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  album_artist: string | null;
  genre: string | null;
  year: number | null;
  duration: number | null;
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
  status: "ok" | "missing" | "processing" | "error" | "disabled";
  tags: Record<string, unknown>;
  created_at: string;
}

export interface Playlist {
  id: number;
  name: string;
  role: "music" | "news" | "jingle" | "general" | "decade";
  rotation: string | null;
  weight: number;
  enabled: boolean;
  sort_order: number;
  item_count?: number;
}

export interface Alert {
  id: number;
  type: string;
  severity: "info" | "warning" | "error" | "critical";
  message: string;
  details: Record<string, unknown> | null;
  created_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
}

export interface RequestRow {
  id: number;
  display_name: string | null;
  contact: string | null;
  artist: string | null;
  title: string | null;
  message: string | null;
  dedication: string | null;
  media_id: number | null;
  status: "pending" | "approved" | "rejected" | "played" | "expired";
  created_at: string;
  played_at: string | null;
  media: { id: number; title?: string; artist?: string; duration?: number } | null;
}

export interface EventRow {
  id: number;
  title: string;
  type: "playlist" | "live" | "stinger";
  start_at: string;
  end_at: string | null;
  priority: number;
  playlist_id: number | null;
  status: string;
}

export interface PlanItem {
  id: number;
  position: number;
  media_id: number | null;
  kind: "music" | "news" | "jingle" | "live";
  start_seconds: number;
  length: number;
  artist: string | null;
  title: string | null;
  is_locked: boolean;
  artworkUrl?: string | null;
}
