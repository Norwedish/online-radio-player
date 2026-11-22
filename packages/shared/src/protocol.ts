import { z } from "zod";

/**
 * Worker protocol (PLAN 6.4.8): newline-delimited JSON between radio-api and
 * radio-playout. Every command is validated on both ends.
 */
export const PROTOCOL_VERSION = 1;

export const queueItemKindSchema = z.enum([
  "music",
  "news",
  "jingle",
  "live",
  "request",
  "stinger",
  "voiceover",
  "emergency",
]);
export type QueueItemKind = z.infer<typeof queueItemKindSchema>;

export const queueItemSchema = z.object({
  uid: z.string(),
  kind: queueItemKindSchema,
  mediaId: z.number().int().nullable().default(null),
  path: z.string(),
  title: z.string().default(""),
  artist: z.string().default(""),
  duration: z.number().nonnegative(),
  cueIn: z.number().nonnegative().default(0),
  cueOut: z.number().nonnegative().nullable().default(null),
  fadeIn: z.number().nonnegative().default(0),
  fadeOut: z.number().nonnegative().default(0),
  gainDb: z.number().default(0),
  planId: z.number().int().nullable().default(null),
  planItemId: z.number().int().nullable().default(null),
  /** Epoch ms the plan wanted this item to start (null for inserted items). */
  plannedStart: z.number().nullable().default(null),
  locked: z.boolean().default(false),
  source: z.enum(["automation", "request", "manual", "event", "live"]).default("automation"),
  requestId: z.number().int().nullable().default(null),
  artworkUrl: z.string().nullable().default(null),
});
export type QueueItem = z.infer<typeof queueItemSchema>;
export type QueueItemInput = z.input<typeof queueItemSchema>;

export const playoutModeSchema = z.enum([
  "idle",
  "autoplay",
  "live",
  "event",
  "interrupt",
  "emergency",
]);
export type PlayoutMode = z.infer<typeof playoutModeSchema>;

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

export interface StereoToolStatus {
  enabled: boolean;
  running: boolean;
  bypassed: boolean;
  mode: string;
  edition: string | null;
  restarts: number;
  error: string | null;
}

export interface LiveStatus {
  active: boolean;
  mode: "duck" | "takeover";
  source: "studio" | "icecast" | "linein" | null;
  userId: number | null;
  sessionId: number | null;
  startedAt: number | null;
  recording: boolean;
  gainDb: number;
  inputPeakDb: number;
}

export interface BoundaryLogEntry {
  at: number;
  boundaryAt: number;
  action: "cut" | "let_finish" | "early_news" | "late_news" | "none";
  deviationMs: number;
  details: Record<string, unknown>;
  planId: number | null;
}

export interface PlayoutState {
  mode: PlayoutMode;
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
  stereotool: StereoToolStatus;
  boundaryLog: BoundaryLogEntry[];
  currentPlan: { planId: number | null; date: string | null; hour: number | null };
  uptimeSeconds: number;
  sampleClock: number;
}

export interface MeterFrame {
  masterPeak: number;
  masterRms: number;
  buses: { name: string; peak: number; rms: number; gain: number }[];
  duckGain: number;
}

/** Commands API → worker. */
export const commandSchemas = {
  ping: z.object({}).default({}),
  "state:get": z.object({}).default({}),
  play: z.object({}).default({}),
  pause: z.object({}).default({}),
  resume: z.object({}).default({}),
  stop: z.object({}).default({}),
  skip: z.object({}).default({}),
  seek: z.object({ position: z.number().nonnegative() }),
  "queue:list": z.object({}).default({}),
  "queue:remove": z.object({ uid: z.string() }),
  "queue:move": z.object({ uid: z.string(), toIndex: z.number().int().nonnegative() }),
  "queue:insert": z.object({
    item: queueItemSchema,
    position: z.union([z.literal("next"), z.literal("end"), z.number().int().nonnegative()]),
  }),
  "queue:jump": z.object({ uid: z.string() }),
  "queue:reload": z.object({}).default({}),
  insert_request: z.object({
    item: queueItemSchema,
    target: z.enum(["play_next", "next_hour"]),
  }),
  play_now: z.object({ item: queueItemSchema }),
  voice_over: z.object({ item: queueItemSchema, duckDb: z.number().optional() }),
  replay_last: z.object({}).default({}),
  "live:start": z.object({
    mode: z.enum(["duck", "takeover"]),
    source: z.enum(["studio", "icecast", "linein"]),
    userId: z.number().int().nullable().default(null),
    sessionId: z.number().int().nullable().default(null),
    record: z.boolean().default(true),
    recordPath: z.string().nullable().default(null),
    /** One-time token the browser studio presents on the worker's live WebSocket. */
    token: z.string().nullable().default(null),
    /** Icecast ingest URL or ALSA device for external/line-in sources. */
    input: z.string().nullable().default(null),
  }),
  "live:stop": z.object({}).default({}),
  "live:set_gain": z.object({ gainDb: z.number().gte(-60).lte(24) }),
  "live:set_mode": z.object({ mode: z.enum(["duck", "takeover"]) }),
  "event:start": z.object({
    id: z.number().int(),
    title: z.string(),
    priority: z.number().int().gte(1).lte(10),
    items: z.array(queueItemSchema),
  }),
  "event:stop": z.object({ id: z.number().int().optional() }),
  "emergency:trigger": z.object({ reason: z.string().default("manual") }),
  "emergency:clear": z.object({}).default({}),
  "fader:set": z.object({ value: z.number().gte(0).lte(1.5) }),
  "monitor:set": z.object({ enabled: z.boolean() }),
  "trigger:fire": z.object({ action: z.string(), args: z.record(z.unknown()).default({}) }),
  "settings:reload": z.object({}).default({}),
} as const;

export type CommandType = keyof typeof commandSchemas;
export type CommandPayload<T extends CommandType> = z.infer<(typeof commandSchemas)[T]>;
export const COMMAND_TYPES = Object.keys(commandSchemas) as CommandType[];

export const envelopeSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  id: z.string().optional(),
  type: z.string(),
  payload: z.unknown().optional(),
  ts: z.number().optional(),
});
export type Envelope = z.infer<typeof envelopeSchema>;

export type WorkerEventType =
  | "hello"
  | "heartbeat"
  | "state"
  | "now_playing"
  | "queue"
  | "meter"
  | "live:status"
  | "track_started"
  | "track_ended"
  | "boundary"
  | "encoder:status"
  | "stereotool:status"
  | "icecast:status"
  | "alert"
  | "error";

export interface WorkerAlert {
  type: string;
  severity: "info" | "warning" | "error" | "critical";
  message: string;
  details?: Record<string, unknown>;
}

export function parseCommand(
  type: string,
  payload: unknown,
): { ok: true; type: CommandType; payload: unknown } | { ok: false; error: string } {
  if (!(type in commandSchemas)) return { ok: false, error: `unknown command ${type}` };
  const schema = commandSchemas[type as CommandType];
  const result = schema.safeParse(payload ?? {});
  if (!result.success) {
    return {
      ok: false,
      error: result.error.issues
        .map((i) => `${i.path.join(".") || "payload"}: ${i.message}`)
        .join("; "),
    };
  }
  return { ok: true, type: type as CommandType, payload: result.data };
}
