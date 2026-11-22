/** Playout control, live studio, events, triggers (PLAN §6.7, M6, M8). */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createReadStream, existsSync, statSync } from "node:fs";
import { z } from "zod";
import { can, type CommandType, type QueueItem } from "@radio/shared";
import type { AppContext } from "../context.js";
import { HttpError, audit, guard, idParam, notFound, parse } from "../http.js";
import { mediaQueueItem } from "../services/queue-items.js";

const controlLimit = { rateLimit: { max: 120, timeWindow: "1 minute" } };

const triggerSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,40}$/),
  label: z.string().max(80),
  action: z.enum([
    "skip",
    "pause",
    "resume",
    "replay_last",
    "emergency",
    "emergency_clear",
    "play_now",
    "voice_over",
    "live_duck",
    "live_takeover",
    "live_stop",
    "event_start",
  ]),
  mediaId: z.number().int().optional(),
  eventId: z.number().int().optional(),
  midi: z
    .object({
      type: z.enum(["note", "cc"]),
      channel: z.number().int().min(1).max(16),
      number: z.number().int().min(0).max(127),
    })
    .optional(),
});
type Trigger = z.infer<typeof triggerSchema>;

export async function playoutRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { repos, worker } = ctx;

  const mediaItem = (mediaId: number, extra: Partial<QueueItem> = {}): QueueItem => {
    const m = repos.media.get(mediaId);
    if (!m || m.status !== "ok") throw notFound("playable media");
    return mediaQueueItem(m, extra);
  };

  /** Sends a command, audits it, returns the new state (M6.1/M6.3). */
  const command = async (
    req: FastifyRequest,
    type: CommandType,
    payload: unknown = {},
    auditMeta?: unknown,
  ) => {
    const state = await worker.send(type, payload);
    audit(
      ctx,
      req,
      `playout.${type}`,
      null,
      null,
      auditMeta ?? (Object.keys(payload as object).length ? payload : undefined),
    );
    return { state };
  };

  const control = {
    preHandler: guard("playout:control", "playout:control"),
    config: { ...controlLimit, tags: ["playout"] },
  };

  app.get(
    "/api/playout/state",
    {
      preHandler: guard("playout:view", "read"),
      config: { summary: "Full playout state", tags: ["playout"] },
    },
    async () => {
      if (!worker.connected) return { connected: false, state: worker.lastState };
      return { connected: true, state: await worker.send("state:get") };
    },
  );

  for (const [path, type, summary] of [
    ["skip", "skip", "Skip current"],
    ["pause", "pause", "Pause output"],
    ["resume", "resume", "Resume output"],
    ["stop", "stop", "Stop automation"],
    ["play", "play", "Start automation"],
    ["replay-last", "replay_last", "Replay last track"],
  ] as const) {
    app.post(
      `/api/playout/${path}`,
      { ...control, config: { ...control.config, summary } },
      async (req) => command(req, type),
    );
  }

  app.post(
    "/api/playout/seek",
    { ...control, config: { ...control.config, summary: "Seek current" } },
    async (req) => command(req, "seek", parse(z.object({ position: z.number().min(0) }), req.body)),
  );

  app.get(
    "/api/playout/queue",
    {
      preHandler: guard("playout:view", "read"),
      config: { summary: "Upcoming queue", tags: ["playout"] },
    },
    async () => {
      const state = worker.connected ? await worker.send("queue:list") : worker.lastState;
      return { items: state?.queue ?? [], nowPlaying: state?.nowPlaying ?? null };
    },
  );

  app.post(
    "/api/playout/queue/move",
    { ...control, config: { ...control.config, summary: "Reorder queue" } },
    async (req) =>
      command(
        req,
        "queue:move",
        parse(z.object({ uid: z.string(), toIndex: z.number().int().min(0) }), req.body),
      ),
  );

  app.delete(
    "/api/playout/queue/:uid",
    { ...control, config: { ...control.config, summary: "Remove queue item" } },
    async (req) => command(req, "queue:remove", parse(z.object({ uid: z.string() }), req.params)),
  );

  app.post(
    "/api/playout/queue/insert",
    { ...control, config: { ...control.config, summary: "Insert media into the queue" } },
    async (req) => {
      const body = parse(
        z.object({
          mediaId: z.number().int(),
          position: z
            .union([z.literal("next"), z.literal("end"), z.number().int().min(0)])
            .default("next"),
        }),
        req.body,
      );
      return command(
        req,
        "queue:insert",
        { item: mediaItem(body.mediaId), position: body.position },
        body,
      );
    },
  );

  app.post(
    "/api/playout/queue/jump",
    { ...control, config: { ...control.config, summary: "Jump to a queued item" } },
    async (req) => command(req, "queue:jump", parse(z.object({ uid: z.string() }), req.body)),
  );

  app.post(
    "/api/playout/play-now",
    {
      ...control,
      config: { ...control.config, summary: "Interrupt / play-now (stinger, ad, jingle, news)" },
    },
    async (req) => {
      const body = parse(
        z.object({
          mediaId: z.number().int(),
          kind: z.enum(["stinger", "jingle", "news", "music", "emergency"]).default("stinger"),
        }),
        req.body,
      );
      return command(req, "play_now", { item: mediaItem(body.mediaId, { kind: body.kind }) }, body);
    },
  );

  app.post(
    "/api/playout/voice-over",
    {
      ...control,
      config: { ...control.config, summary: "Play a voice-over over the music (ducked)" },
    },
    async (req) => {
      const body = parse(
        z.object({ mediaId: z.number().int(), duckDb: z.number().min(-40).max(0).optional() }),
        req.body,
      );
      return command(
        req,
        "voice_over",
        { item: mediaItem(body.mediaId, { kind: "voiceover" }), duckDb: body.duckDb },
        body,
      );
    },
  );

  app.patch(
    "/api/playout/fader",
    { ...control, config: { ...control.config, summary: "Master fader (0–1.5)" } },
    async (req) =>
      command(req, "fader:set", parse(z.object({ value: z.number().min(0).max(1.5) }), req.body)),
  );

  app.post(
    "/api/playout/monitor",
    { ...control, config: { ...control.config, summary: "Monitor on/off" } },
    async (req) => command(req, "monitor:set", parse(z.object({ enabled: z.boolean() }), req.body)),
  );

  app.post(
    "/api/playout/emergency",
    { ...control, config: { ...control.config, summary: "Trigger or clear emergency mode" } },
    async (req) => {
      const body = parse(
        z.object({
          action: z.enum(["trigger", "clear"]),
          reason: z.string().max(200).default("manual"),
        }),
        req.body,
      );
      const res = await command(
        req,
        body.action === "trigger" ? "emergency:trigger" : "emergency:clear",
        body.action === "trigger" ? { reason: body.reason } : {},
        body,
      );
      if (body.action === "trigger")
        void ctx.alerts.raise({
          type: "emergency_manual",
          severity: "critical",
          message: `Emergency triggered by ${req.auth.user?.username ?? "API key"}: ${body.reason}`,
        });
      else ctx.alerts.resolve("dead_air");
      return res;
    },
  );

  app.get(
    "/api/playout/history",
    {
      preHandler: guard("playout:view", "read"),
      config: { summary: "Recently played", tags: ["playout"] },
    },
    async (req) => {
      const q = parse(z.object({ limit: z.coerce.number().int().max(200).default(30) }), req.query);
      return { items: repos.history.recent(q.limit) };
    },
  );

  /* ── Live studio (M8) ──────────────────────────────────────────────── */

  app.post(
    "/api/live/start",
    {
      preHandler: guard("live:broadcast"),
      config: { summary: "Start a live session", tags: ["live"] },
    },
    async (req) => {
      const body = parse(
        z.object({
          mode: z.enum(["duck", "takeover"]).default("duck"),
          source: z.enum(["studio", "icecast", "linein"]).default("studio"),
          record: z.boolean().default(true),
          input: z.string().max(200).nullable().optional(),
          notes: z.string().max(500).optional(),
        }),
        req.body,
      );
      const result = await ctx.live.start({ ...body, userId: req.auth.user!.id });
      audit(ctx, req, "live.start", "live_session", result.session.id, {
        mode: body.mode,
        source: body.source,
        record: body.record,
      });
      ctx.bus.publish("live", "live:session", { active: true, session: result.session });
      return result;
    },
  );

  app.post(
    "/api/live/stop",
    {
      preHandler: guard("live:broadcast"),
      config: { summary: "Stop the live session", tags: ["live"] },
    },
    async (req) => {
      const open = repos.live.open();
      if (open && open.user_id !== req.auth.user!.id && !can(req.auth.user!.role, "live:manage"))
        throw new HttpError(
          403,
          "forbidden",
          "only the DJ on air or an operator can stop this session",
        );
      const session = await ctx.live.stop();
      audit(ctx, req, "live.stop", "live_session", session?.id ?? null, {
        duration: session?.duration,
      });
      ctx.bus.publish("live", "live:session", { active: false, session });
      return { session };
    },
  );

  app.post(
    "/api/live/mode",
    {
      preHandler: guard("live:broadcast"),
      config: { summary: "Switch duck/takeover", tags: ["live"] },
    },
    async (req) =>
      command(
        req,
        "live:set_mode",
        parse(z.object({ mode: z.enum(["duck", "takeover"]) }), req.body),
      ),
  );

  app.post(
    "/api/live/gain",
    {
      preHandler: guard("live:broadcast"),
      config: { summary: "Live input gain (dB)", tags: ["live"] },
    },
    async (req) =>
      command(
        req,
        "live:set_gain",
        parse(z.object({ gainDb: z.number().min(-60).max(24) }), req.body),
      ),
  );

  app.get(
    "/api/live/status",
    { preHandler: guard("playout:view"), config: { summary: "Live status", tags: ["live"] } },
    async () => ({ live: worker.lastState?.live ?? null, session: repos.live.open() ?? null }),
  );

  app.get(
    "/api/live/recordings",
    {
      preHandler: guard("recordings:manage"),
      config: { summary: "List recordings", tags: ["live"] },
    },
    async () => ({ items: repos.live.recordings() }),
  );

  app.get(
    "/api/live/recordings/:id",
    {
      preHandler: guard("recordings:manage"),
      config: { summary: "Download a recording", tags: ["live"] },
    },
    async (req, reply) => {
      const { id } = parse(idParam, req.params);
      const s = repos.live.get(id);
      if (!s?.recorded_path || !existsSync(s.recorded_path)) throw notFound("recording");
      reply
        .header("content-disposition", `attachment; filename="live-${id}.flac"`)
        .header("content-length", String(statSync(s.recorded_path).size));
      return reply.type("audio/flac").send(createReadStream(s.recorded_path));
    },
  );

  app.delete(
    "/api/live/recordings/:id",
    {
      preHandler: guard("recordings:manage"),
      config: { summary: "Delete a recording", tags: ["live"] },
    },
    async (req) => {
      const { id } = parse(idParam, req.params);
      if (!ctx.live.deleteRecording(id)) throw notFound("recording");
      audit(ctx, req, "live.recording_delete", "live_session", id);
      return { ok: true };
    },
  );

  app.get(
    "/api/live/sessions",
    {
      preHandler: guard("stats:view"),
      config: { summary: "DJ shift reports (own sessions for DJs)", tags: ["live"] },
    },
    async (req) => {
      const q = parse(
        z.object({ since: z.string().optional(), until: z.string().optional() }),
        req.query,
      );
      const since = q.since ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
      const until = q.until ?? new Date(Date.now() + 86_400_000).toISOString();
      const own = req.auth.user!.role === "dj" ? req.auth.user!.id : undefined;
      return {
        sessions: repos.live.list({ userId: own, since, until }),
        report: repos.live
          .shiftReport(since, until)
          .filter((r) => own === undefined || r.user_id === own),
      };
    },
  );

  /* ── Events (M6.5) ─────────────────────────────────────────────────── */

  const eventBody = z.object({
    title: z.string().min(1).max(120),
    type: z.enum(["playlist", "live", "stinger"]),
    startAt: z.string().datetime({ offset: true }),
    endAt: z.string().datetime({ offset: true }).nullable().optional(),
    priority: z.number().int().min(1).max(10).default(5),
    playlistId: z.number().int().nullable().optional(),
  });

  app.get(
    "/api/events",
    { preHandler: guard("schedule:view"), config: { summary: "List events", tags: ["events"] } },
    async (req) => {
      const q = parse(
        z.object({ from: z.string().optional(), status: z.string().optional() }),
        req.query,
      );
      return { items: repos.events.list(q) };
    },
  );

  app.post(
    "/api/events",
    { preHandler: guard("events:manage"), config: { summary: "Create event", tags: ["events"] } },
    async (req, reply) => {
      const body = parse(eventBody, req.body);
      if (body.type !== "live" && !body.playlistId)
        throw new HttpError(400, "validation_error", "playlist and stinger events need a playlist");
      if (body.endAt && Date.parse(body.endAt) <= Date.parse(body.startAt))
        throw new HttpError(400, "validation_error", "endAt must be after startAt");
      const ev = repos.events.create({
        title: body.title,
        type: body.type,
        startAt: new Date(body.startAt).toISOString(),
        endAt: body.endAt ? new Date(body.endAt).toISOString() : null,
        priority: body.priority,
        playlistId: body.playlistId ?? null,
        createdBy: req.auth.user!.id,
      });
      audit(ctx, req, "event.create", "event", ev.id, body);
      return reply.status(201).send({ event: ev });
    },
  );

  app.patch(
    "/api/events/:id",
    { preHandler: guard("events:manage"), config: { summary: "Update event", tags: ["events"] } },
    async (req) => {
      const { id } = parse(idParam, req.params);
      const body = parse(eventBody.partial(), req.body);
      const ev = repos.events.update(id, {
        ...(body.title ? { title: body.title } : {}),
        ...(body.startAt ? { start_at: new Date(body.startAt).toISOString() } : {}),
        ...(body.endAt !== undefined
          ? { end_at: body.endAt ? new Date(body.endAt).toISOString() : null }
          : {}),
        ...(body.priority ? { priority: body.priority } : {}),
        ...(body.playlistId !== undefined ? { playlist_id: body.playlistId } : {}),
      });
      if (!ev) throw notFound("event");
      audit(ctx, req, "event.update", "event", id, body);
      return { event: ev };
    },
  );

  app.delete(
    "/api/events/:id",
    {
      preHandler: guard("events:manage"),
      config: { summary: "Delete a non-active event", tags: ["events"] },
    },
    async (req) => {
      const { id } = parse(idParam, req.params);
      if (!repos.events.delete(id))
        throw new HttpError(409, "conflict", "event not found or active");
      audit(ctx, req, "event.delete", "event", id);
      return { ok: true };
    },
  );

  app.post(
    "/api/events/:id/start",
    {
      preHandler: guard("events:manage"),
      config: { summary: "Start event now", tags: ["events"] },
    },
    async (req) => {
      const { id } = parse(idParam, req.params);
      const ev = await ctx.events.start(id);
      audit(ctx, req, "event.start", "event", id);
      return { event: ev };
    },
  );

  app.post(
    "/api/events/:id/stop",
    { preHandler: guard("events:manage"), config: { summary: "Stop event", tags: ["events"] } },
    async (req) => {
      const { id } = parse(idParam, req.params);
      const ev = await ctx.events.stop(id);
      audit(ctx, req, "event.stop", "event", id);
      return { event: ev };
    },
  );

  /* ── Triggers: MIDI / Stream Deck / hardware (M6.6) ───────────────── */

  const triggers = (): Trigger[] => repos.settings.get<Trigger[]>("triggers", []);

  app.get(
    "/api/admin/triggers",
    {
      preHandler: guard("settings:manage"),
      config: { summary: "List trigger mappings", tags: ["triggers"] },
    },
    async () => ({ items: triggers() }),
  );

  app.put(
    "/api/admin/triggers",
    {
      preHandler: guard("settings:manage"),
      config: { summary: "Replace trigger mappings", tags: ["triggers"] },
    },
    async (req) => {
      const body = parse(z.object({ items: z.array(triggerSchema).max(100) }), req.body);
      repos.settings.set("triggers", body.items);
      audit(ctx, req, "triggers.update", null, null, { count: body.items.length });
      return { items: body.items };
    },
  );

  app.post(
    "/api/triggers/:id",
    {
      config: {
        rateLimit: { max: 60, timeWindow: "1 minute" },
        summary: "Fire a trigger (API key scope triggers:fire)",
        tags: ["triggers"],
      },
    },
    async (req) => {
      if (
        !req.auth.apiKey?.scopes.includes("triggers:fire") &&
        !(req.auth.user && can(req.auth.user.role, "playout:control"))
      ) {
        throw new HttpError(401, "unauthorized", "API key with triggers:fire scope required");
      }
      const { id } = parse(z.object({ id: z.string() }), req.params);
      const t = triggers().find((x) => x.id === id);
      if (!t) throw notFound("trigger");
      let res: unknown;
      switch (t.action) {
        case "play_now":
          res = await command(
            req,
            "play_now",
            { item: mediaItem(t.mediaId ?? -1, { kind: "stinger" }) },
            { trigger: id },
          );
          break;
        case "voice_over":
          res = await command(
            req,
            "voice_over",
            { item: mediaItem(t.mediaId ?? -1, { kind: "voiceover" }) },
            { trigger: id },
          );
          break;
        case "live_duck":
        case "live_takeover":
          res = await command(
            req,
            "live:set_mode",
            { mode: t.action === "live_duck" ? "duck" : "takeover" },
            { trigger: id },
          );
          break;
        case "live_stop":
          res = { session: await ctx.live.stop() };
          audit(ctx, req, "trigger.live_stop", null, null, { trigger: id });
          break;
        case "event_start":
          res = { event: await ctx.events.start(t.eventId ?? -1) };
          audit(ctx, req, "trigger.event_start", "event", t.eventId, { trigger: id });
          break;
        default:
          res = await command(req, "trigger:fire", { action: t.action, args: {} }, { trigger: id });
      }
      return { fired: id, ...(res as object) };
    },
  );
}
