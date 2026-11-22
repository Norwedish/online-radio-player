import { z } from "zod";

/**
 * Schedule settings and hour template (PLAN §7.2) — the playlist_maker
 * `data/state.json` settings ported into `schedule_settings` rows.
 */

export const templateBlockSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(["news", "music", "jingle", "live"]),
    /** Minutes into the hour, half-open [start, end). */
    start: z.number().int().gte(0).lte(60),
    end: z.number().int().gte(0).lte(60),
    locked: z.boolean().optional(),
    rotation: z.string().optional(),
    /** Optional explicit playlist names to draw from (overrides the hour playlist). */
    playlists: z.array(z.string()).optional(),
  })
  .strict()
  .refine((b) => b.end > b.start, { message: "block end must be after start" });

export type TemplateBlock = z.infer<typeof templateBlockSchema>;

export const hourOverrideSchema = z
  .object({
    disabled: z.boolean().optional(),
    live: z.boolean().optional(),
    locked: z.boolean().optional(),
    playlistName: z.string().optional(),
    blocks: z.array(templateBlockSchema).optional(),
    note: z.string().max(200).optional(),
  })
  .strict();

export type HourOverride = z.infer<typeof hourOverrideSchema>;

/** Overrides keyed by hour ("0".."23"); optional date-specific keys "YYYY-MM-DD:H". */
export const templateOverridesSchema = z.record(z.string(), hourOverrideSchema);
export type TemplateOverrides = z.infer<typeof templateOverridesSchema>;

export const DEFAULT_TEMPLATE: TemplateBlock[] = [
  { id: "news-00", type: "news", start: 0, end: 3, locked: true },
  { id: "music-1", type: "music", start: 3, end: 30, rotation: "default" },
  { id: "news-30", type: "news", start: 30, end: 33, locked: true },
  { id: "music-2", type: "music", start: 33, end: 60, rotation: "default" },
];

export const generatorSettingsSchema = z
  .object({
    prefix: z.string().default("[PM]"),
    news_path_hour: z.string().default("Nieuws/nieuws-heel-uur.mp3"),
    news_path_half: z.string().default("Nieuws/nieuws-half-uur.mp3"),
    news_reserve_seconds: z.number().int().gte(0).default(180),
    separation_track_hours: z.number().gte(0).default(4),
    separation_artist_hours: z.number().gte(0).default(1),
    hour_min_seconds: z.number().int().default(3540),
    hour_max_seconds: z.number().int().default(3720),
    generate_hour_00_at: z.string().default("23:00"),
    generate_rest_at: z.string().default("00:05"),
    locale: z.string().default("en"),
    disable_fallback_playlists: z.boolean().default(true),
    auto_disable_legacy_news: z.boolean().default(true),
    fallback_mode: z.boolean().default(false),
    overrun_allowed_seconds: z.number().int().gte(0).default(90),
    tail_window_seconds: z.number().int().gte(0).default(300),
    tail_overrun_seconds: z.number().int().gte(0).default(45),
  })
  .strict();

export type GeneratorSettings = z.infer<typeof generatorSettingsSchema>;

export const GENERATOR_SETTINGS_DEFAULTS: GeneratorSettings = generatorSettingsSchema.parse({});

/** schedule_settings keys. */
export const SCHEDULE_KEYS = {
  generator: "generator",
  templateBase: "template.base",
  templateOverrides: "template.overrides",
  fallbackMode: "fallback_mode",
} as const;

/** Playlist naming conventions kept from playlist_maker. */
export function hourPlaylistName(hour: number, prefix = "[PM]"): string {
  return `${prefix} ${String(hour).padStart(2, "0")}:00`;
}

export const DECADE_PLAYLISTS = [
  "00s",
  "10s",
  "20s",
  "30s",
  "40s",
  "50s",
  "60s",
  "70s",
  "80s",
  "90s",
];
export const GENERAL_PLAYLIST = "General";
export const NEWS_PLAYLIST = "Nieuws";
export const JINGLES_PLAYLIST = "Jingles";
export const EMERGENCY_PLAYLIST = "Emergency";
