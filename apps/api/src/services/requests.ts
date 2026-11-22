/**
 * Listener requests (PLAN §5.5 / M6.4 / M11.3): validation, profanity filter,
 * blacklist, per-IP cooldown + hourly/daily limits, library matching with a
 * free-text fallback into moderation, optional auto-approve, and insertion
 * into the playout queue (play next / next hour).
 */
import { normalizeForMatch, type RequestRow, type Repositories } from "@radio/db";
import type { RuntimeConfig } from "@radio/shared";
import type { EventBus } from "./bus.js";
import { mediaQueueItem } from "./queue-items.js";
import type { WorkerClient } from "../worker-client.js";

export class RequestError extends Error {
  constructor(
    readonly code:
      | "disabled"
      | "invalid"
      | "profanity"
      | "blacklisted"
      | "cooldown"
      | "rate_limited"
      | "not_found",
    message: string,
    readonly statusCode = 400,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/** Small built-in list (EN + NL); stations extend it with the blacklist. */
const PROFANITY = [
  "fuck",
  "shit",
  "cunt",
  "bitch",
  "asshole",
  "bastard",
  "dick",
  "pussy",
  "nigger",
  "faggot",
  "whore",
  "slut",
  "motherfucker",
  "kut",
  "kanker",
  "tering",
  "tyfus",
  "klootzak",
  "lul",
  "hoer",
  "godverdomme",
  "mongool",
  "flikker",
  "teef",
];

export function containsProfanity(text: string, extra: string[] = []): boolean {
  const norm = ` ${text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[@4]/g, "a")
    .replace(/[3]/g, "e")
    .replace(/[1!|]/g, "i")
    .replace(/[0]/g, "o")
    .replace(/[$5]/g, "s")
    .replace(/[^a-z]+/g, " ")} `;
  return [...PROFANITY, ...extra].some(
    (w) => norm.includes(` ${w} `) || (w.length >= 5 && norm.includes(w)),
  );
}

export interface RequestInput {
  artist?: string;
  title?: string;
  mediaId?: number;
  message?: string;
  dedication?: string;
  displayName?: string;
  contact?: string;
}

export class RequestService {
  constructor(
    private readonly repos: Repositories,
    private readonly config: RuntimeConfig,
    private readonly worker: WorkerClient,
    private readonly bus: EventBus,
  ) {}

  private s<T>(key: string, fallback: T): T {
    return this.repos.settings.get(key, fallback);
  }

  isBlacklisted(text: string): boolean {
    const norm = normalizeForMatch(text);
    const patterns = [
      ...this.config.requests.blacklistPatterns.map((p) => ({
        pattern: p,
        match_type: "contains",
      })),
      ...this.repos.requests.blacklist(),
    ];
    return patterns.some((p) => {
      const pat = normalizeForMatch(p.pattern);
      if (!pat) return false;
      return p.match_type === "exact" ? norm === pat : norm.includes(pat);
    });
  }

  async submit(input: RequestInput, ip: string, now = new Date()): Promise<RequestRow> {
    if (!this.config.requests.enabled || !this.s("requests.enabled", true))
      throw new RequestError("disabled", "requests are disabled", 403);
    const max = this.config.requests.maxLengthCharacters;
    for (const [k, v] of Object.entries(input)) {
      if (typeof v === "string" && v.length > max)
        throw new RequestError("invalid", `${k} is too long (max ${max})`);
    }
    if (input.dedication && !this.s("requests.dedications", this.config.requests.dedications))
      throw new RequestError("invalid", "dedications are disabled");
    let media = input.mediaId ? this.repos.media.get(input.mediaId) : undefined;
    if (input.mediaId && (!media || media.status !== "ok"))
      throw new RequestError("not_found", "that track is not in the library", 404);
    if (!media && !(input.title?.trim() || input.artist?.trim()))
      throw new RequestError("invalid", "artist or title is required");
    const free = [input.message, input.dedication, input.displayName, input.title, input.artist]
      .filter(Boolean)
      .join(" ");
    if (
      this.s("requests.profanityFilter", this.config.requests.profanityFilter) &&
      containsProfanity(free)
    )
      throw new RequestError("profanity", "please keep it clean");
    const artist = media?.artist ?? input.artist?.trim() ?? null;
    const title = media?.title ?? input.title?.trim() ?? null;
    if (this.isBlacklisted(`${artist ?? ""} ${title ?? ""}`))
      throw new RequestError("blacklisted", "this track cannot be requested", 403);

    // Per-IP cooldown, hourly and daily limits.
    const cooldown = this.s("requests.cooldownMinutes", this.config.requests.cooldownMinutes);
    const last = this.repos.requests.lastFromIp(ip);
    if (cooldown > 0 && last) {
      const wait = Date.parse(last.created_at) + cooldown * 60_000 - now.getTime();
      if (wait > 0)
        throw new RequestError(
          "cooldown",
          `you can request again in ${Math.ceil(wait / 60_000)} minute(s)`,
          429,
          Math.ceil(wait / 1000),
        );
    }
    const window = now.toISOString().slice(0, 13);
    const hourCount = this.repos.requests.hitRateLimit(ip, window);
    if (hourCount > this.s("requests.maxPerHour", this.config.requests.maxPerHour))
      throw new RequestError(
        "rate_limited",
        "too many requests this hour",
        429,
        3600 - now.getUTCMinutes() * 60,
      );
    const day = this.repos.requests.countFromIpSince(
      ip,
      new Date(now.getTime() - 86_400_000).toISOString(),
    );
    if (day >= this.config.requests.maxPerIpPerDay)
      throw new RequestError("rate_limited", "daily request limit reached", 429, 3600);

    // Library matching for free-text requests.
    if (!media && artist && title) {
      const candidates = this.repos.media.search({ q: title, status: "ok", limit: 50 }).items;
      media = candidates.find(
        (m) =>
          normalizeForMatch(m.title ?? "") === normalizeForMatch(title) &&
          normalizeForMatch(m.artist ?? "") === normalizeForMatch(artist),
      );
    }
    const autoApprove =
      this.s("requests.autoApprove", this.config.requests.autoApprove) && media !== undefined;
    const row = this.repos.requests.create({
      ip,
      displayName: input.displayName?.trim() || null,
      contact: input.contact?.trim() || null,
      artist,
      title,
      message: input.message?.trim() || null,
      dedication: input.dedication?.trim() || null,
      mediaId: media?.id ?? null,
      status: "pending",
    });
    this.bus.publish("requests", "requests:new", row);
    if (autoApprove) return this.approve(row.id, "next_hour", null).catch(() => row);
    return row;
  }

  async approve(
    id: number,
    target: "play_next" | "next_hour",
    userId: number | null,
  ): Promise<RequestRow> {
    const req = this.repos.requests.get(id);
    if (!req) throw new RequestError("not_found", "request not found", 404);
    if (!req.media_id)
      throw new RequestError(
        "invalid",
        "link the request to a library track before approving",
        409,
      );
    const media = this.repos.media.get(req.media_id);
    if (!media || media.status !== "ok")
      throw new RequestError("not_found", "track is not playable", 409);
    const item = mediaQueueItem(media, {
      kind: "request",
      source: "request",
      requestId: req.id,
      title: media.title ?? req.title ?? "",
    });
    await this.worker.send("insert_request", { item, target });
    const row = this.repos.requests.moderate(
      id,
      "approved",
      userId,
      target === "play_next" ? 1 : 0,
    )!;
    this.bus.publish("requests", "requests:updated", row);
    return row;
  }

  reject(id: number, userId: number | null): RequestRow {
    const row = this.repos.requests.moderate(id, "rejected", userId);
    if (!row) throw new RequestError("not_found", "request not found", 404);
    this.bus.publish("requests", "requests:updated", row);
    return row;
  }

  linkMedia(id: number, mediaId: number): RequestRow {
    if (!this.repos.media.get(mediaId)) throw new RequestError("not_found", "media not found", 404);
    this.repos.requests.setMedia(id, mediaId);
    return this.repos.requests.get(id)!;
  }

  markPlayed(id: number): void {
    this.repos.requests.markPlayed(id);
    this.bus.publish("requests", "requests:updated", this.repos.requests.get(id));
  }

  /** Public status (no PII). */
  publicStatus(id: number): {
    id: number;
    status: string;
    artist: string | null;
    title: string | null;
    created_at: string;
    played_at: string | null;
  } | null {
    const r = this.repos.requests.get(id);
    return r
      ? {
          id: r.id,
          status: r.status,
          artist: r.artist,
          title: r.title,
          created_at: r.created_at,
          played_at: r.played_at,
        }
      : null;
  }
}
