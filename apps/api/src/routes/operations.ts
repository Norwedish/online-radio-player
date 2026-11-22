/** Requests moderation, alerts, stats, settings, backups (PLAN §6.7, M10, M12). */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { backupDatabase, listBackupFiles, type Repositories } from "@radio/db";
import type { AppContext } from "../context.js";
import { HttpError, actor, audit, guard, idParam, notFound, parse } from "../http.js";
import { SETTING_DEFINITIONS } from "../services/settings.js";

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  // Neutralize spreadsheet formula injection and quote.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  return (
    [columns.join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))].join(
      "\r\n",
    ) + "\r\n"
  );
}

export async function runBackup(
  ctx: AppContext,
  repos: Repositories,
): Promise<Awaited<ReturnType<typeof backupDatabase>>> {
  const result = await backupDatabase(repos.db, ctx.config.backups.dir, {
    dailyKeep: repos.settings.get("backups.dailyKeep", ctx.config.backups.dailyKeep),
    weeklyKeep: repos.settings.get("backups.weeklyKeep", ctx.config.backups.weeklyKeep),
  });
  repos.backups.record(result.path, "daily", result.size, true);
  if (result.weeklyPath) repos.backups.record(result.weeklyPath, "weekly", result.size, true);
  repos.backups.forget(result.removed);
  return result;
}

export async function operationsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { repos } = ctx;

  /* ── Requests moderation (M10.4) ───────────────────────────────────── */

  app.get(
    "/api/requests",
    {
      preHandler: guard("requests:moderate"),
      config: { summary: "Moderation queue", tags: ["requests"] },
    },
    async (req) => {
      const q = parse(
        z.object({
          status: z.enum(["pending", "approved", "rejected", "played", "expired"]).optional(),
          limit: z.coerce.number().int().max(500).optional(),
          offset: z.coerce.number().int().optional(),
        }),
        req.query,
      );
      const result = repos.requests.list(q);
      const media = new Map(
        repos.media
          .getMany(result.items.map((r) => r.media_id).filter((x): x is number => x !== null))
          .map((m) => [m.id, m]),
      );
      return {
        ...result,
        items: result.items.map((r) => ({
          ...r,
          media: r.media_id
            ? {
                id: r.media_id,
                title: media.get(r.media_id)?.title,
                artist: media.get(r.media_id)?.artist,
                duration: media.get(r.media_id)?.duration,
              }
            : null,
        })),
        counts: repos.requests.countByStatus(),
      };
    },
  );

  app.post(
    "/api/requests/:id/approve",
    {
      preHandler: guard("requests:moderate"),
      config: { summary: "Approve (inserted into the next hour)", tags: ["requests"] },
    },
    async (req) => {
      const { id } = parse(idParam, req.params);
      const row = await ctx.requests.approve(id, "next_hour", req.auth.user!.id);
      audit(ctx, req, "request.approve", "request", id);
      return { request: row };
    },
  );

  app.post(
    "/api/requests/:id/play-next",
    {
      preHandler: guard("requests:moderate"),
      config: { summary: "Approve and play next", tags: ["requests"] },
    },
    async (req) => {
      const { id } = parse(idParam, req.params);
      const row = await ctx.requests.approve(id, "play_next", req.auth.user!.id);
      audit(ctx, req, "request.play_next", "request", id);
      return { request: row };
    },
  );

  app.post(
    "/api/requests/:id/reject",
    { preHandler: guard("requests:moderate"), config: { summary: "Reject", tags: ["requests"] } },
    async (req) => {
      const { id } = parse(idParam, req.params);
      const row = ctx.requests.reject(id, req.auth.user!.id);
      audit(ctx, req, "request.reject", "request", id);
      return { request: row };
    },
  );

  app.post(
    "/api/requests/:id/link",
    {
      preHandler: guard("requests:moderate"),
      config: { summary: "Link a free-text request to a library track", tags: ["requests"] },
    },
    async (req) => {
      const { id } = parse(idParam, req.params);
      const body = parse(z.object({ mediaId: z.number().int() }), req.body);
      const row = ctx.requests.linkMedia(id, body.mediaId);
      audit(ctx, req, "request.link", "request", id, body);
      return { request: row };
    },
  );

  app.get(
    "/api/requests/blacklist",
    {
      preHandler: guard("requests:moderate"),
      config: { summary: "Request blacklist", tags: ["requests"] },
    },
    async () => ({
      items: repos.requests.blacklist(),
      configPatterns: ctx.config.requests.blacklistPatterns,
    }),
  );

  app.post(
    "/api/requests/blacklist",
    {
      preHandler: guard("requests:moderate"),
      config: { summary: "Add blacklist pattern", tags: ["requests"] },
    },
    async (req, reply) => {
      const body = parse(
        z.object({
          pattern: z.string().min(2).max(200),
          matchType: z.enum(["contains", "exact", "artist", "title"]).default("contains"),
        }),
        req.body,
      );
      const id = repos.requests.addBlacklist(body.pattern, body.matchType, req.auth.user!.id);
      audit(ctx, req, "request.blacklist_add", "request_blacklist", id, body);
      return reply.status(201).send({ id });
    },
  );

  app.delete(
    "/api/requests/blacklist/:id",
    {
      preHandler: guard("requests:moderate"),
      config: { summary: "Remove blacklist pattern", tags: ["requests"] },
    },
    async (req) => {
      const { id } = parse(idParam, req.params);
      if (!repos.requests.removeBlacklist(id)) throw notFound("pattern");
      audit(ctx, req, "request.blacklist_remove", "request_blacklist", id);
      return { ok: true };
    },
  );

  /* ── Alerts (M10.6) ─────────────────────────────────────────────────── */

  app.get(
    "/api/alerts",
    {
      preHandler: guard("alerts:view"),
      config: { summary: "Alerts (active/history)", tags: ["alerts"] },
    },
    async (req) => {
      const q = parse(
        z.object({
          active: z.coerce.boolean().optional(),
          severity: z.enum(["info", "warning", "error", "critical"]).optional(),
          limit: z.coerce.number().int().max(1000).optional(),
          offset: z.coerce.number().int().optional(),
        }),
        req.query,
      );
      return { ...repos.alerts.list(q), activeCount: repos.alerts.countActive() };
    },
  );

  app.post(
    "/api/alerts/:id/ack",
    { preHandler: guard("alerts:ack"), config: { summary: "Acknowledge", tags: ["alerts"] } },
    async (req) => {
      const { id } = parse(idParam, req.params);
      if (!repos.alerts.get(id)) throw notFound("alert");
      repos.alerts.acknowledge(id, req.auth.user!.id);
      audit(ctx, req, "alert.ack", "alert", id);
      ctx.bus.publish("alerts", "alerts:ack", { id });
      return { alert: repos.alerts.get(id) };
    },
  );

  app.post(
    "/api/alerts/test",
    {
      preHandler: guard("settings:manage"),
      config: { summary: "Send a test alert through every channel", tags: ["alerts"] },
    },
    async (req) => {
      const body = parse(
        z.object({ severity: z.enum(["info", "warning", "error", "critical"]).default("error") }),
        req.body,
      );
      const row = await ctx.alerts.raise({
        type: `test_${Date.now()}`,
        severity: body.severity,
        message: `Test alert from ${req.auth.user!.username}`,
      });
      audit(ctx, req, "alert.test", "alert", row?.id ?? null);
      return {
        alert: row,
        mail: ctx.mailer.outbox.at(-1) ?? null,
        webhooks: ctx.alerts.webhookLog.slice(-5),
      };
    },
  );

  /* ── Stats (M12.3) ─────────────────────────────────────────────────── */

  const range = z.object({
    since: z.string().optional(),
    until: z.string().optional(),
    bucketMinutes: z.coerce.number().int().min(1).max(1440).optional(),
  });
  const resolveRange = (q: { since?: string; until?: string }, days = 1) => ({
    since: q.since ?? new Date(Date.now() - days * 86_400_000).toISOString(),
    until: q.until ?? new Date(Date.now() + 60_000).toISOString(),
  });

  app.get(
    "/api/stats/listeners",
    {
      preHandler: guard("stats:view"),
      config: { summary: "Listener series + per-mount breakdown", tags: ["stats"] },
    },
    async (req) => {
      const q = parse(range, req.query);
      const r = resolveRange(q);
      return {
        ...r,
        series: repos.listeners.series(r.since, r.until, q.bucketMinutes ?? 5),
        current: repos.listeners.current(),
        peak: repos.listeners.peak(r.since, r.until),
        live: ctx.sync.listeners,
      };
    },
  );

  app.get(
    "/api/stats/history",
    { preHandler: guard("stats:view"), config: { summary: "Played history", tags: ["stats"] } },
    async (req) => {
      const q = parse(
        range.extend({
          limit: z.coerce.number().int().max(5000).default(200),
          offset: z.coerce.number().int().default(0),
        }),
        req.query,
      );
      const r = resolveRange(q, 7);
      return { items: repos.history.recent(q.limit, q.offset, r.since, r.until) };
    },
  );

  app.get(
    "/api/stats/airplay",
    { preHandler: guard("stats:view"), config: { summary: "Airplay analytics", tags: ["stats"] } },
    async (req) => {
      const r = resolveRange(parse(range, req.query), 7);
      return {
        ...r,
        ...repos.history.airplay(r.since, r.until),
        requests: repos.requests.countByStatus(),
        shifts: repos.live.shiftReport(r.since, r.until),
      };
    },
  );

  app.get(
    "/api/stats/export",
    {
      preHandler: guard("stats:view"),
      config: { summary: "CSV export (history|listeners|airplay|shifts)", tags: ["stats"] },
    },
    async (req, reply) => {
      const q = parse(
        range.extend({
          type: z.enum(["history", "listeners", "airplay", "shifts"]).default("history"),
        }),
        req.query,
      );
      const r = resolveRange(q, 30);
      let csv: string;
      if (q.type === "history")
        csv = toCsv(
          repos.history.recent(5000, 0, r.since, r.until) as unknown as Record<string, unknown>[],
          [
            "started_at",
            "ended_at",
            "artist",
            "title",
            "album",
            "duration",
            "source",
            "listeners_peak",
            "media_id",
          ],
        );
      else if (q.type === "listeners")
        csv = toCsv(repos.listeners.series(r.since, r.until, q.bucketMinutes ?? 15), [
          "ts",
          "mount",
          "listeners",
        ]);
      else if (q.type === "shifts")
        csv = toCsv(
          repos.live.list({ since: r.since, until: r.until, limit: 5000 }) as unknown as Record<
            string,
            unknown
          >[],
          ["started_at", "ended_at", "username", "mode", "duration", "peak_listeners", "notes"],
        );
      else
        csv = toCsv(
          repos.history.airplay(r.since, r.until).topTracks as unknown as Record<string, unknown>[],
          ["media_id", "artist", "title", "plays"],
        );
      reply.header(
        "content-disposition",
        `attachment; filename="${q.type}-${r.since.slice(0, 10)}-${r.until.slice(0, 10)}.csv"`,
      );
      return reply.type("text/csv; charset=utf-8").send(`\uFEFF${csv}`);
    },
  );

  /* ── Settings (M9.5 / M1.5) ────────────────────────────────────────── */

  app.get(
    "/api/settings",
    {
      preHandler: guard("settings:view"),
      config: { summary: "Station + typed settings", tags: ["settings"] },
    },
    async () => ({
      station: repos.stations.get(repos.stationId),
      settings: ctx.settings.list(),
      definitions: Object.fromEntries(
        Object.entries(SETTING_DEFINITIONS).map(([k, d]) => [
          k,
          { category: d.category, label: d.label, reloadsWorker: d.worker },
        ]),
      ),
    }),
  );

  app.patch(
    "/api/settings",
    {
      preHandler: guard("settings:manage"),
      config: { summary: "Update settings and/or station branding", tags: ["settings"] },
    },
    async (req) => {
      const body = parse(
        z.object({
          settings: z.record(z.unknown()).optional(),
          station: z
            .object({
              name: z.string().min(2).max(100).optional(),
              timezone: z.string().min(3).max(64).optional(),
              locale: z.string().min(2).max(10).optional(),
              logo_url: z.string().max(300).nullable().optional(),
              colors: z.record(z.string().regex(/^#[0-9a-fA-F]{6}$/)).optional(),
            })
            .optional(),
        }),
        req.body,
      );
      if (
        body.station?.timezone &&
        !Intl.supportedValuesOf("timeZone").includes(body.station.timezone)
      )
        throw new HttpError(400, "validation_error", "unknown timezone");
      const result = body.settings
        ? await ctx.settings.update(body.settings, actor(req))
        : { changed: [], workerReloaded: false };
      if (body.station) {
        repos.stations.update(repos.stationId, body.station);
        audit(ctx, req, "station.update", "station", repos.stationId, body.station);
      }
      return {
        ...result,
        station: repos.stations.get(repos.stationId),
        settings: ctx.settings.list(),
      };
    },
  );

  for (const category of ["audio", "live", "requests", "retention", "backups", "alerts"] as const) {
    app.get(
      `/api/settings/${category}`,
      {
        preHandler: guard("settings:view"),
        config: { summary: `${category} settings`, tags: ["settings"] },
      },
      async () => ({ settings: ctx.settings.list(category) }),
    );
    app.patch(
      `/api/settings/${category}`,
      {
        preHandler: guard("settings:manage"),
        config: { summary: `Update ${category} settings`, tags: ["settings"] },
      },
      async (req) => {
        const patch = parse(z.record(z.unknown()), req.body);
        const bad = Object.keys(patch).filter((k) => !k.startsWith(`${category}.`));
        if (bad.length)
          throw new HttpError(
            400,
            "validation_error",
            `keys outside ${category}: ${bad.join(", ")}`,
          );
        return {
          ...(await ctx.settings.update(patch, actor(req))),
          settings: ctx.settings.list(category),
        };
      },
    );
  }

  /** Read-only views of file-based config (Stereo Tool / Icecast are not edited in the UI — PLAN §2.2). */
  app.get(
    "/api/settings/stereotool",
    {
      preHandler: guard("settings:view"),
      config: { summary: "Stereo Tool configuration + status", tags: ["settings"] },
    },
    async () => {
      const st = ctx.config.stereotool;
      return {
        config: {
          enabled: st.enabled,
          binary: st.binary,
          preset: st.preset,
          edition: st.edition,
          inputMode: st.inputMode,
          args: st.args,
          wavIo: st.wavIo,
          restart: st.restart,
          bypassOnFailure: st.bypassOnFailure,
          mock: ctx.config.stereotoolMock,
        },
        status: ctx.worker.lastState?.stereotool ?? null,
      };
    },
  );

  app.get(
    "/api/settings/icecast",
    {
      preHandler: guard("settings:view"),
      config: { summary: "Icecast mounts + status", tags: ["settings"] },
    },
    async () => ({
      config: {
        host: ctx.config.icecast.host,
        port: ctx.config.icecast.port,
        mounts: ctx.config.icecast.mounts,
        hls: ctx.config.icecast.hls,
        liveMount: ctx.config.icecast.liveMount,
      },
      encoders: ctx.worker.lastState?.encoders ?? [],
      lastPoll: ctx.sync.lastIcecastPoll,
    }),
  );

  /* ── Backups (M12.4) ───────────────────────────────────────────────── */

  app.get(
    "/api/admin/backups",
    {
      preHandler: guard("settings:manage"),
      config: { summary: "List backups", tags: ["backups"] },
    },
    async () => ({ items: repos.backups.list(), files: listBackupFiles(ctx.config.backups.dir) }),
  );

  app.post(
    "/api/admin/backups",
    {
      preHandler: guard("settings:manage"),
      config: { summary: "Run a backup now", tags: ["backups"] },
    },
    async (req) => {
      try {
        const result = await runBackup(ctx, repos);
        audit(ctx, req, "backup.run", null, null, { path: result.path, size: result.size });
        ctx.alerts.resolve("backup_failed");
        return result;
      } catch (e) {
        void ctx.alerts.raise({
          type: "backup_failed",
          severity: "error",
          message: `Backup failed: ${(e as Error).message}`,
        });
        throw e;
      }
    },
  );
}
