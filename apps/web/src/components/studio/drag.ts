/**
 * Drag-and-drop in the studio: library tracks (library drawer, pre-listen) onto the
 * players, the queue and pre-listen, and queue items onto pre-listen. Private MIME
 * types keep these drags apart from each other and from text or files dragged in.
 */
import type { DragEvent } from "react";

const MEDIA_MIME = "application/x-radio-media";
/** Seconds after cue-in to start from (a position found in pre-listen). */
const CUE_MIME = "application/x-radio-cue";
const QUEUE_MIME = "application/x-radio-queue";

export function startMediaDrag(
  e: DragEvent,
  media: { id: number; title: string | null },
  cuePoint?: number,
): void {
  e.dataTransfer.setData(MEDIA_MIME, String(media.id));
  if (cuePoint !== undefined && cuePoint > 0)
    e.dataTransfer.setData(CUE_MIME, String(Math.round(cuePoint * 10) / 10));
  e.dataTransfer.setData("text/plain", media.title ?? "");
  e.dataTransfer.effectAllowed = "copyMove";
}

/** True while a library track is dragged (works during dragover, when the data is hidden). */
export function isMediaDrag(e: DragEvent): boolean {
  return e.dataTransfer.types.includes(MEDIA_MIME);
}

/** The dropped track (and start position, if any), or null for any other drag. */
export function droppedMedia(e: DragEvent): { mediaId: number; cuePoint?: number } | null {
  const mediaId = Number(e.dataTransfer.getData(MEDIA_MIME));
  if (!Number.isInteger(mediaId) || mediaId <= 0) return null;
  const cue = Number(e.dataTransfer.getData(CUE_MIME));
  return Number.isFinite(cue) && cue > 0 ? { mediaId, cuePoint: cue } : { mediaId };
}

/** A queue item is dragged (reorder within the queue, or onto pre-listen). */
export function startQueueDrag(e: DragEvent, item: { uid: string; title: string }): void {
  e.dataTransfer.setData(QUEUE_MIME, item.uid);
  // Firefox only starts a drag that carries data; text/plain also names it for other apps.
  e.dataTransfer.setData("text/plain", item.title);
  e.dataTransfer.effectAllowed = "copyMove";
}

export function isQueueDrag(e: DragEvent): boolean {
  return e.dataTransfer.types.includes(QUEUE_MIME);
}

export function droppedQueueUid(e: DragEvent): string | null {
  return e.dataTransfer.getData(QUEUE_MIME) || null;
}
