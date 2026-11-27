import { randomUUID } from "node:crypto";
import type { MediaRow } from "@radio/db";
import type { QueueItem } from "@radio/shared";

/** Builds a worker queue item from a media row (manual inserts, requests, events). */
export function mediaQueueItem(m: MediaRow, extra: Partial<QueueItem> = {}): QueueItem {
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
    source: "manual",
    requestId: null,
    artworkUrl: m.artwork_path ? `/api/media/${m.id}/artwork` : null,
    ...itemMarkers(m, cueIn),
    ...extra,
  };
}

/** Intro/outro markers relative to cue-in (stored as file time on the media row). */
export function itemMarkers(
  m: Pick<MediaRow, "intro_end" | "outro_start">,
  cueIn: number,
): { intro: number | null; outro: number | null } {
  const rel = (v: number | null | undefined) =>
    v !== null && v !== undefined && v > cueIn ? Math.round((v - cueIn) * 1000) / 1000 : null;
  return { intro: rel(m.intro_end), outro: rel(m.outro_start) };
}
