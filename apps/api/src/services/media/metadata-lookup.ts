/**
 * Metadata lookup (M2.7): MusicBrainz recording search → review queue.
 * Suggestions are never applied automatically; an operator applies or
 * rejects them in the media library. MusicBrainz asks clients for at most
 * one request per second and a descriptive User-Agent.
 */
import type { Repositories } from "@radio/db";
import { HttpError, notFound } from "../../http.js";

const MB = "https://musicbrainz.org/ws/2/recording";
const USER_AGENT = "online-radio-player/0.1 (self-hosted radio automation)";
const MIN_SCORE = 60;

export interface Suggestion {
  artist: string;
  title: string;
  album: string | null;
  year: number | null;
  score: number;
  mbid: string;
  releaseId: string | null;
}

interface MbRecording {
  id: string;
  score?: number;
  title?: string;
  "artist-credit"?: { name?: string; joinphrase?: string }[];
  releases?: { id: string; title?: string; date?: string; status?: string }[];
  "first-release-date"?: string;
}

let lastCallAt = 0;

async function throttle(minIntervalMs: number): Promise<void> {
  const wait = lastCallAt + minIntervalMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

const quote = (s: string) => `"${s.replace(/["\\]/g, " ").trim()}"`;

export function parseRecordings(json: { recordings?: MbRecording[] }): Suggestion[] {
  return (json.recordings ?? [])
    .map((r) => {
      const artist = (r["artist-credit"] ?? [])
        .map((c) => `${c.name ?? ""}${c.joinphrase ?? ""}`)
        .join("")
        .trim();
      const release = r.releases?.find((x) => x.status === "Official") ?? r.releases?.[0];
      const date = r["first-release-date"] ?? release?.date ?? "";
      const year = /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null;
      return {
        artist,
        title: r.title ?? "",
        album: release?.title ?? null,
        year,
        score: r.score ?? 0,
        mbid: r.id,
        releaseId: release?.id ?? null,
      };
    })
    .filter((s) => s.artist && s.title && s.score >= MIN_SCORE);
}

/** Looks a media row up on MusicBrainz and queues up to 3 suggestions; returns how many were added. */
export async function suggestForMedia(
  repos: Repositories,
  id: number,
  options: { fetchImpl?: typeof fetch; minIntervalMs?: number } = {},
): Promise<number> {
  const media = repos.media.get(id);
  if (!media) throw notFound("media");
  const title = media.title?.trim();
  if (!title) throw new HttpError(400, "no_title", "the track needs at least a title to look up");
  const parts = [`recording:${quote(title)}`];
  if (media.artist?.trim()) parts.push(`artist:${quote(media.artist)}`);
  const url = `${MB}?fmt=json&limit=5&query=${encodeURIComponent(parts.join(" AND "))}`;
  await throttle(options.minIntervalMs ?? 1100);
  const res = await (options.fetchImpl ?? fetch)(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new HttpError(502, "lookup_failed", `MusicBrainz answered ${res.status}`);
  const suggestions = parseRecordings((await res.json()) as { recordings?: MbRecording[] });
  const pending = new Set(
    repos.media
      .listSuggestions()
      .filter((s) => s.media_id === id)
      .map((s) => String(s.payload.mbid)),
  );
  let added = 0;
  for (const s of suggestions.slice(0, 3)) {
    if (pending.has(s.mbid)) continue;
    const same =
      s.title.toLowerCase() === title.toLowerCase() &&
      s.artist.toLowerCase() === (media.artist ?? "").toLowerCase() &&
      (s.album ?? "") === (media.album ?? "") &&
      (s.year ?? null) === (media.year ?? null);
    if (same) continue;
    repos.media.addSuggestion(id, "musicbrainz", s);
    added += 1;
  }
  return added;
}

/** Applies a pending suggestion's artist/title/album/year to its media row. */
export function applySuggestion(repos: Repositories, suggestionId: number): void {
  const s = repos.media.getSuggestion(suggestionId);
  if (!s) throw notFound("suggestion");
  if (s.status !== "pending") throw new HttpError(409, "conflict", `suggestion is ${s.status}`);
  const media = repos.media.get(s.media_id);
  if (!media) throw notFound("media");
  const p = s.payload as Partial<Suggestion>;
  repos.media.update(media.id, {
    ...(p.title ? { title: p.title } : {}),
    ...(p.artist ? { artist: p.artist } : {}),
    ...(p.album ? { album: p.album } : {}),
    ...(p.year ? { year: p.year } : {}),
    tags: {
      ...media.tags,
      edited: true,
      tagsMissing: false,
      musicbrainz: { recording: p.mbid, release: p.releaseId ?? null },
    },
  });
  repos.media.resolveSuggestion(suggestionId, "applied");
}
