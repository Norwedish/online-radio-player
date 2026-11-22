/** Public listener API (PLAN §5.8 / M11.2–M11.5): CORS, rate limited, no PII. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { addDays, stationNow } from "@radio/core";
import type { AppContext } from "../context.js";
import { HttpError, guard, parse } from "../http.js";

export async function publicRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { repos } = ctx;
  const pub = { config: { rateLimit: { max: 60, timeWindow: "1 minute" }, tags: ["public"] } };

  app.addHook("onSend", async (req, reply) => {
    if (req.url.startsWith("/api/public/")) {
      reply.header("access-control-allow-origin", "*");
      reply.header("access-control-allow-headers", "content-type, x-api-key");
      reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
    }
  });
  app.options("/api/public/*", async (_req, reply) => reply.status(204).send());

  const streams = () => {
    const mounts = ctx.config.icecast.mounts
      .filter((m) => m.public)
      .map((m) => ({
        mount: m.name,
        url: `/stream/${m.name}`,
        codec: m.codec,
        bitrate: m.bitrate,
        contentType: m.contentType,
        primary: m.primary,
      }));
    return { mounts, hls: ctx.config.icecast.hls.enabled ? "/hls/stream.m3u8" : null };
  };

  app.get(
    "/api/public/now-playing",
    { config: { ...pub.config, summary: "Now playing, next up, listeners, streams" } },
    async () => {
      const state = ctx.worker.lastState;
      const np = state?.nowPlaying ?? null;
      const station = repos.stations.get(repos.stationId);
      const live = state?.live?.active ? repos.live.open() : undefined;
      return {
        station: {
          name: station?.name ?? ctx.config.station.name,
          timezone: station?.timezone,
          logoUrl: station?.logo_url ?? null,
          colors: station?.colors ?? {},
        },
        nowPlaying:
          np && np.kind !== "news"
            ? {
                title: np.title,
                artist: np.artist,
                kind: np.kind,
                artworkUrl: np.artworkUrl,
                startedAt: new Date(np.startedAt).toISOString(),
                duration: np.duration,
                position: np.position,
                isRequest: np.source === "request",
              }
            : np
              ? {
                  title: "News",
                  artist: station?.name ?? "",
                  kind: "news",
                  artworkUrl: null,
                  startedAt: new Date(np.startedAt).toISOString(),
                  duration: np.duration,
                  position: np.position,
                  isRequest: false,
                }
              : null,
        next: (state?.queue ?? []).slice(0, 3).map((q) => ({
          title: q.kind === "news" ? "News" : q.title,
          artist: q.kind === "news" ? "" : q.artist,
          kind: q.kind,
        })),
        live: {
          active: Boolean(state?.live?.active),
          dj: live?.username ?? null,
          since: live?.started_at ?? null,
        },
        listeners: ctx.sync.listeners,
        onAir: Boolean(state && !state.stopped),
        streams: streams(),
        updatedAt: new Date().toISOString(),
      };
    },
  );

  app.get(
    "/api/public/schedule",
    { config: { ...pub.config, summary: "Public 24h schedule (planned times)" } },
    async (req) => {
      const q = parse(
        z.object({
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
        }),
        req.query,
      );
      const now = stationNow(ctx.generator.tz);
      const date = q.date ?? now.date;
      if (date < addDays(now.date, -1) || date > addDays(now.date, 2))
        throw new HttpError(
          400,
          "out_of_range",
          "schedule is available for yesterday through the day after tomorrow",
        );
      const slots = repos.schedule.slots();
      return {
        date,
        timezone: ctx.generator.tz,
        hours: Array.from({ length: 24 }, (_, hour) => {
          const override = ctx.generator.overrideFor(date, hour);
          const plan = repos.schedule.plan(date, hour);
          const items = plan ? repos.schedule.items(plan.id).filter((i) => i.kind === "music") : [];
          const slot = slots.find((s) => s.hour === hour);
          return {
            hour,
            title: override.live
              ? "Live"
              : (override.note ??
                (override.playlistName ?? slot?.playlist_name ?? "").replace(
                  /^\[PM\]\s*/,
                  "Music ",
                )),
            live: Boolean(override.live),
            current: date === now.date && hour === now.hour,
            tracks: items
              .slice(0, 20)
              .map((i) => ({ at: Math.round(i.start_seconds), artist: i.artist, title: i.title })),
          };
        }),
      };
    },
  );

  app.get(
    "/api/public/history",
    { config: { ...pub.config, summary: "Recently played" } },
    async (req) => {
      const q = parse(
        z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }),
        req.query,
      );
      return {
        items: repos.history.recent(q.limit).map((h) => ({
          title: h.title,
          artist: h.artist,
          album: h.album,
          startedAt: h.started_at,
          artworkUrl: h.artwork_path ? `/api/media/${h.media_id}/artwork` : null,
          source: h.source,
        })),
      };
    },
  );

  app.get(
    "/api/public/search",
    { config: { ...pub.config, summary: "Library search for requests (artist/title only)" } },
    async (req) => {
      const q = parse(z.object({ q: z.string().min(2).max(100) }), req.query);
      return {
        items: repos.media
          .search({ q: q.q, status: "ok", limit: 20 })
          .items.filter((m) => !/^nieuws\//i.test(m.relative_path ?? ""))
          .map((m) => ({
            id: m.id,
            artist: m.artist,
            title: m.title,
            album: m.album,
            duration: m.duration,
          })),
      };
    },
  );

  app.post(
    "/api/public/requests",
    {
      config: {
        rateLimit: { max: 10, timeWindow: "1 minute" },
        tags: ["public"],
        summary: "Submit a song request",
      },
    },
    async (req, reply) => {
      const body = parse(
        z.object({
          mediaId: z.number().int().optional(),
          artist: z.string().max(200).optional(),
          title: z.string().max(200).optional(),
          message: z.string().max(500).optional(),
          dedication: z.string().max(300).optional(),
          displayName: z.string().max(80).optional(),
          contact: z.string().max(200).optional(),
          website: z.string().max(0).optional(), // honeypot: must stay empty
        }),
        req.body,
      );
      const { website: _hp, ...input } = body;
      const row = await ctx.requests.submit(input, req.ip);
      return reply.status(201).send({ request: ctx.requests.publicStatus(row.id) });
    },
  );

  app.get(
    "/api/public/requests/:id",
    { config: { ...pub.config, summary: "Request status" } },
    async (req) => {
      const { id } = parse(z.object({ id: z.coerce.number().int() }), req.params);
      const s = ctx.requests.publicStatus(id);
      if (!s) throw new HttpError(404, "not_found", "request not found");
      return { request: s };
    },
  );

  app.get(
    "/api/public/stats",
    {
      preHandler: guard("stats:view", "public:stats"),
      config: { ...pub.config, summary: "Partner stats (API key scope public:stats)" },
    },
    async () => {
      const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
      const air = repos.history.airplay(dayAgo, new Date(Date.now() + 60_000).toISOString());
      return {
        listeners: {
          current: ctx.sync.listeners,
          peak24h: repos.listeners.peak(dayAgo),
          mounts: repos.listeners.current(),
        },
        plays24h: air.totalPlays,
        uniqueArtists24h: air.uniqueArtists,
        topTracks24h: air.topTracks.slice(0, 10),
        requests: repos.requests.countByStatus(),
      };
    },
  );
}
