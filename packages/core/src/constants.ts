/**
 * Boundary rules are defined in PLAN.md §6.4.5.
 * This constant is the default tolerance for letting a track overrun the hour
 * boundary, or starting news early, before forcing a cut.
 */
export const DEFAULT_BOUNDARY_TOLERANCE_SECONDS = 45;

/** Generator defaults ported from playlist_maker. */
export const GENERATOR_DEFAULTS = {
  separationTrackHours: 4,
  separationArtistHours: 1,
  hourMinSeconds: 3540,
  hourMaxSeconds: 3720,
  overrunAllowedSeconds: 90,
  tailWindowSeconds: 300,
  tailOverrunSeconds: 45,
  newsReserveSeconds: 180,
} as const;

/** News blocks are locked at :00 and :30 in the default template. */
export const DEFAULT_NEWS_BLOCKS = [
  { id: "news-00", startMinute: 0, endMinute: 3 },
  { id: "news-30", startMinute: 30, endMinute: 33 },
] as const;

export const PROJECT_VERSION = "0.1.0";
