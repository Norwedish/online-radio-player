/**
 * 24×1h generator (PLAN §7.3 / M3.3), ported from playlist_maker's algorithm:
 *
 *  - Locked news blocks sit at their template minute (:00 / :30).
 *  - Each music block fills the gap up to the next locked block:
 *      normal fill  → weighted picks (play-count penalty) honouring separation,
 *                     a pick may overrun the block end by ≤ overrun_allowed_seconds;
 *      tail window  → once ≤ tail_window_seconds remain, prefer a *closer*
 *                     (one track landing within −tail/+tail_overrun of the end),
 *                     else a *completer* pair, else a *fill* candidate;
 *      relaxation   → if nothing passes separation: drop artist separation,
 *                     then track separation, each with a warning.
 *  - Deterministic: a seeded PRNG keyed on date/hour/seed.
 */
import type { GeneratorSettings, TemplateBlock } from "@radio/shared";
import type { SeparationTracker } from "./separation.js";

export interface Candidate {
  mediaId: number;
  artist: string | null;
  title: string | null;
  /** Effective play length in seconds (cue_out − cue_in). */
  duration: number;
  playlistId: number | null;
  weight: number;
  /** Plays in the recent window (for the play-count penalty). */
  playCount: number;
}

export interface GeneratedItem {
  mediaId: number | null;
  kind: "music" | "news" | "jingle" | "live";
  startSeconds: number;
  length: number;
  playlistId: number | null;
  artist: string | null;
  title: string | null;
  locked: boolean;
  blockId: string;
  reason:
    | "fill"
    | "tail-closer"
    | "tail-completer"
    | "tail-fill"
    | "news"
    | "jingle"
    | "relaxed-artist"
    | "relaxed-track"
    | "live";
}

export interface GenerateHourInput {
  date: string;
  hour: number;
  /** Epoch ms of the hour start (station timezone resolved by the caller). */
  hourStartMs: number;
  blocks: TemplateBlock[];
  settings: GeneratorSettings;
  pools: {
    music: Candidate[];
    jingles?: Candidate[];
    /** Optional per-block named playlists (block.playlists). */
    byPlaylistName?: Record<string, Candidate[]>;
  };
  news: { hour: Candidate | null; half: Candidate | null };
  separation: SeparationTracker;
  seed?: string;
}

export interface GenerateHourResult {
  date: string;
  hour: number;
  items: GeneratedItem[];
  totalSeconds: number;
  warnings: string[];
  stats: { music: number; closers: number; completers: number; relaxed: number };
}

/* ── Deterministic PRNG ─────────────────────────────────────────────────── */

export function hashSeed(text: string): number {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0 || 1;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

export function effectiveWeight(c: Candidate): number {
  return Math.max(0.0001, c.weight) / (1 + 0.5 * Math.max(0, c.playCount));
}

function weightedPick<T>(items: T[], weight: (t: T) => number, rnd: () => number): T | undefined {
  if (items.length === 0) return undefined;
  const total = items.reduce((s, i) => s + weight(i), 0);
  let r = rnd() * total;
  for (const item of items) {
    r -= weight(item);
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

type Level = "strict" | "artist" | "track";

function eligible(
  c: Candidate,
  sep: SeparationTracker,
  atMs: number,
  level: Level,
  used: Set<number>,
): boolean {
  if (used.has(c.mediaId)) return false;
  if (level === "strict") return sep.canPlay(c.mediaId, c.artist, atMs);
  if (level === "artist") return sep.trackOk(c.mediaId, atMs);
  return true;
}

/* ── Music block filler ─────────────────────────────────────────────────── */

interface FillContext {
  blockId: string;
  pool: Candidate[];
  startSec: number;
  endSec: number;
  input: GenerateHourInput;
  rnd: () => number;
  used: Set<number>;
  warnings: string[];
  stats: GenerateHourResult["stats"];
}

function fillMusicBlock(ctx: FillContext): GeneratedItem[] {
  const { settings, separation, hourStartMs } = ctx.input;
  const tailWindow = settings.tail_window_seconds;
  const tailOverrun = settings.tail_overrun_seconds;
  const overrunAllowed = settings.overrun_allowed_seconds;
  const underrun = tailOverrun; // news may start early by up to the boundary tolerance
  const items: GeneratedItem[] = [];
  let cursor = ctx.startSec;
  const at = (sec: number) => hourStartMs + sec * 1000;

  const place = (c: Candidate, reason: GeneratedItem["reason"]) => {
    items.push({
      mediaId: c.mediaId,
      kind: "music",
      startSeconds: cursor,
      length: c.duration,
      playlistId: c.playlistId,
      artist: c.artist,
      title: c.title,
      locked: false,
      blockId: ctx.blockId,
      reason,
    });
    separation.add(c.mediaId, c.artist, at(cursor));
    ctx.used.add(c.mediaId);
    cursor += c.duration;
    ctx.stats.music += 1;
  };

  if (ctx.pool.length === 0) {
    ctx.warnings.push(`${ctx.blockId}: no music candidates available`);
    return items;
  }

  let guard = 0;
  while (guard++ < 500) {
    const remaining = ctx.endSec - cursor;
    if (remaining <= underrun) break;

    if (remaining <= tailWindow) {
      // Tail: closer → completer → fill, each at strict then relaxed levels.
      let placed = false;
      for (const level of ["strict", "artist", "track"] as Level[]) {
        const pool = ctx.pool.filter((c) => eligible(c, separation, at(cursor), level, ctx.used));
        const closers = pool.filter(
          (c) => c.duration >= remaining - underrun && c.duration <= remaining + tailOverrun,
        );
        if (closers.length > 0) {
          // Prefer the best fits (smallest |error|), weighted among the closest few.
          const ranked = [...closers]
            .sort((a, b) => Math.abs(a.duration - remaining) - Math.abs(b.duration - remaining))
            .slice(0, 5);
          const pick = weightedPick(
            ranked,
            (c) => effectiveWeight(c) / (1 + Math.abs(c.duration - remaining) / 10),
            ctx.rnd,
          )!;
          if (level !== "strict")
            ctx.warnings.push(
              `${ctx.blockId}: separation relaxed (${level}) for closer "${pick.title ?? pick.mediaId}"`,
            );
          place(
            pick,
            level === "strict"
              ? "tail-closer"
              : level === "artist"
                ? "relaxed-artist"
                : "relaxed-track",
          );
          if (level !== "strict") ctx.stats.relaxed += 1;
          ctx.stats.closers += 1;
          placed = true;
          break;
        }
        // Completer: a pair landing in the window.
        const short = pool
          .filter((c) => c.duration < remaining)
          .sort((a, b) => a.duration - b.duration)
          .slice(0, 400);
        let best: [Candidate, Candidate, number] | null = null;
        let lo = 0;
        let hi = short.length - 1;
        while (lo < hi) {
          const a = short[lo]!;
          const b = short[hi]!;
          const sum = a.duration + b.duration;
          if (sum < remaining - underrun) lo += 1;
          else if (sum > remaining + tailOverrun) hi -= 1;
          else {
            const err = Math.abs(sum - remaining);
            const sameArtist =
              level === "strict" &&
              a.artist &&
              b.artist &&
              a.artist.toLowerCase() === b.artist.toLowerCase() &&
              separation.artistHours > 0;
            if (!sameArtist && (!best || err < best[2] || (err === best[2] && ctx.rnd() < 0.5)))
              best = [a, b, err];
            if (ctx.rnd() < 0.5) lo += 1;
            else hi -= 1;
          }
        }
        if (best) {
          const [a, b] = ctx.rnd() < 0.5 ? [best[0], best[1]] : [best[1], best[0]];
          place(a, level === "strict" ? "tail-completer" : "relaxed-artist");
          if (eligible(b, separation, at(cursor), level, ctx.used)) {
            place(b, level === "strict" ? "tail-completer" : "relaxed-artist");
            ctx.stats.completers += 1;
            if (level !== "strict") {
              ctx.warnings.push(`${ctx.blockId}: separation relaxed (${level}) for completer pair`);
              ctx.stats.relaxed += 1;
            }
            placed = true;
            break;
          }
          placed = true; // first half placed; loop continues with the new remaining
          break;
        }
        // Tail fill: anything that doesn't blow past the tail overrun.
        const fills = pool.filter((c) => c.duration <= remaining + tailOverrun);
        const fill = weightedPick(fills, effectiveWeight, ctx.rnd);
        if (fill) {
          if (level !== "strict") {
            ctx.warnings.push(`${ctx.blockId}: separation relaxed (${level}) in tail fill`);
            ctx.stats.relaxed += 1;
          }
          place(
            fill,
            level === "strict"
              ? "tail-fill"
              : level === "artist"
                ? "relaxed-artist"
                : "relaxed-track",
          );
          placed = true;
          break;
        }
      }
      if (!placed) {
        // Last resort: general candidate overrun (overrun_allowed_seconds) instead of dead air.
        const over = ctx.pool
          .filter(
            (c) =>
              eligible(c, separation, at(cursor), "track", ctx.used) &&
              c.duration <= remaining + overrunAllowed,
          )
          .sort((a, b) => a.duration - b.duration)[0];
        if (over) {
          ctx.warnings.push(
            `${ctx.blockId}: tail overrun of ${Math.round(over.duration - remaining)} s (general overrun allowance)`,
          );
          place(over, "tail-fill");
          continue;
        }
        ctx.warnings.push(
          `${ctx.blockId}: could not fill the last ${Math.round(remaining)} s (no candidate short enough)`,
        );
        break;
      }
      continue;
    }

    // Normal fill.
    let placed = false;
    for (const level of ["strict", "artist", "track"] as Level[]) {
      const pool = ctx.pool.filter(
        (c) =>
          eligible(c, separation, at(cursor), level, ctx.used) &&
          c.duration <= remaining + overrunAllowed,
      );
      // Dead-zone look-ahead: avoid picks that leave a remainder too short for any
      // closer yet too long to count as on time (underrun < rest < shortest − tail overrun).
      const minDur = pool.reduce((m, c) => Math.min(m, c.duration), Infinity);
      const safe = pool.filter((c) => {
        const rest = remaining - c.duration;
        if (rest < -tailOverrun) return remaining > tailWindow + c.duration; // overrun only if far from the end (never)
        return rest <= underrun || rest >= minDur - tailOverrun;
      });
      const pick = weightedPick(safe.length > 0 ? safe : pool, effectiveWeight, ctx.rnd);
      if (pick) {
        if (level !== "strict") {
          ctx.warnings.push(
            `${ctx.blockId}: separation relaxed (${level}) at ${Math.round(cursor)} s`,
          );
          ctx.stats.relaxed += 1;
        }
        place(
          pick,
          level === "strict" ? "fill" : level === "artist" ? "relaxed-artist" : "relaxed-track",
        );
        placed = true;
        break;
      }
    }
    if (!placed) {
      if (ctx.used.size > 0 && ctx.pool.every((c) => ctx.used.has(c.mediaId))) {
        // Small pools: allow a repeat inside the same hour rather than dead air.
        ctx.used.clear();
        ctx.warnings.push(`${ctx.blockId}: pool exhausted, repeats allowed`);
        continue;
      }
      ctx.warnings.push(`${ctx.blockId}: no candidate fits at ${Math.round(cursor)} s`);
      break;
    }
  }
  const final = ctx.endSec - cursor;
  if (final > underrun) ctx.warnings.push(`${ctx.blockId}: underrun of ${Math.round(final)} s`);
  if (-final > tailOverrun + 0.001 && -final > overrunAllowed + 0.001)
    ctx.warnings.push(`${ctx.blockId}: overrun of ${Math.round(-final)} s`);
  return items;
}

/* ── Hour generator ─────────────────────────────────────────────────────── */

export function generateHour(input: GenerateHourInput): GenerateHourResult {
  const rnd = mulberry32(hashSeed(`${input.date}|${input.hour}|${input.seed ?? "pm"}`));
  const warnings: string[] = [];
  const stats = { music: 0, closers: 0, completers: 0, relaxed: 0 };
  const used = new Set<number>();
  const blocks = [...input.blocks].sort((a, b) => a.start - b.start);
  const items: GeneratedItem[] = [];
  let cursor = 0;

  blocks.forEach((block, index) => {
    const blockStart = block.start * 60;
    const nextLocked = blocks.slice(index + 1).find((b) => b.locked || b.type === "news");
    const blockEnd = (nextLocked ? nextLocked.start : 60) * 60;

    if (block.type === "news") {
      const news = block.start === 0 ? input.news.hour : (input.news.half ?? input.news.hour);
      if (!news) {
        warnings.push(`${block.id}: news media not found`);
        cursor = Math.max(cursor, blockStart);
        return;
      }
      items.push({
        mediaId: news.mediaId,
        kind: "news",
        startSeconds: blockStart,
        length: news.duration,
        playlistId: news.playlistId,
        artist: news.artist,
        title: news.title,
        locked: true,
        blockId: block.id,
        reason: "news",
      });
      const reserve = input.settings.news_reserve_seconds;
      if (news.duration > (block.end - block.start) * 60 + 30)
        warnings.push(
          `${block.id}: news is ${Math.round(news.duration)} s, longer than its ${reserve} s reserve`,
        );
      cursor = blockStart + news.duration;
      return;
    }

    if (block.type === "live") {
      items.push({
        mediaId: null,
        kind: "live",
        startSeconds: blockStart,
        length: (block.end - block.start) * 60,
        playlistId: null,
        artist: null,
        title: "Live",
        locked: true,
        blockId: block.id,
        reason: "live",
      });
      cursor = block.end * 60;
      return;
    }

    if (block.type === "jingle") {
      const jingle = weightedPick(input.pools.jingles ?? [], effectiveWeight, rnd);
      if (jingle) {
        items.push({
          mediaId: jingle.mediaId,
          kind: "jingle",
          startSeconds: Math.max(cursor, blockStart),
          length: jingle.duration,
          playlistId: jingle.playlistId,
          artist: jingle.artist,
          title: jingle.title,
          locked: Boolean(block.locked),
          blockId: block.id,
          reason: "jingle",
        });
        cursor = Math.max(cursor, blockStart) + jingle.duration;
      } else warnings.push(`${block.id}: no jingles available`);
      return;
    }

    // Music: draw from named playlists if the block specifies them, else the hour pool.
    const named = block.playlists?.flatMap((n) => input.pools.byPlaylistName?.[n] ?? []) ?? [];
    const pool = named.length > 0 ? named : input.pools.music;
    const start = Math.max(cursor, blockStart);
    const filled = fillMusicBlock({
      blockId: block.id,
      pool,
      startSec: start,
      endSec: blockEnd,
      input,
      rnd,
      used,
      warnings,
      stats,
    });
    items.push(...filled);
    const last = filled[filled.length - 1];
    cursor = last ? last.startSeconds + last.length : start;
  });

  items.sort((a, b) => a.startSeconds - b.startSeconds || (a.locked ? -1 : 1));
  const end = items.reduce((m, i) => Math.max(m, i.startSeconds + i.length), 0);
  const totalSeconds = Math.round(end * 1000) / 1000;
  if (items.some((i) => i.kind === "music" || i.kind === "news")) {
    if (totalSeconds < input.settings.hour_min_seconds)
      warnings.push(
        `hour total ${Math.round(totalSeconds)} s is below hour_min_seconds ${input.settings.hour_min_seconds}`,
      );
    if (totalSeconds > input.settings.hour_max_seconds)
      warnings.push(
        `hour total ${Math.round(totalSeconds)} s exceeds hour_max_seconds ${input.settings.hour_max_seconds}`,
      );
  }
  return {
    date: input.date,
    hour: input.hour,
    items,
    totalSeconds,
    warnings: [...new Set(warnings)],
    stats,
  };
}
