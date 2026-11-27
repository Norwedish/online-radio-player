/** Health/readiness (M12.6), Prometheus metrics (M12.2), WebSocket hub (M6.2), OpenAPI (M11.4). */
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { PROJECT_NAME, PROJECT_VERSION, can } from "@radio/shared";
import type { AppContext } from "../context.js";
import type { BusMessage, Channel } from "../services/bus.js";
import { HttpError } from "../http.js";

export interface RouteInfo {
  method: string;
  url: string;
  summary?: string;
  tags?: string[];
}

export function buildOpenApi(routes: RouteInfo[], ctx: AppContext): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    if (!r.url.startsWith("/api/") || r.method === "HEAD" || r.method === "OPTIONS") continue;
    const url = r.url.replace(/:([a-zA-Z]+)/g, "{$1}");
    const params = [...r.url.matchAll(/:([a-zA-Z]+)/g)].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    const isPublic =
      r.url.startsWith("/api/public/") ||
      [
        "/api/health",
        "/api/ready",
        "/api/auth/login",
        "/api/auth/password/forgot",
        "/api/auth/password/reset",
        "/api/auth/token",
        "/api/auth/token/revoke",
      ].includes(r.url);
    paths[url] ??= {};
    paths[url][r.method.toLowerCase()] = {
      summary: r.summary ?? `${r.method} ${r.url}`,
      tags: r.tags ?? [r.url.split("/")[2] ?? "api"],
      ...(params.length ? { parameters: params } : {}),
      ...(isPublic ? { security: r.url === "/api/public/stats" ? [{ apiKey: [] }] : [] } : {}),
      responses: {
        "200": {
          description: "OK",
          content: { "application/json": { schema: { type: "object" } } },
        },
        "4XX": {
          description: "Error",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: `${ctx.config.station.name} API`,
      version: PROJECT_VERSION,
      description:
        "Public listener API (now playing, schedule, history, requests) and the authenticated control API (browser session, app bearer token or API key). See docs/api.md and docs/mobile-app-api.md.",
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        session: {
          type: "apiKey",
          in: "cookie",
          name: "radio_session",
          description: "Login session; mutations also need the x-csrf-token header",
        },
        apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
        appToken: {
          type: "http",
          scheme: "bearer",
          description:
            "App access token (rat_…) from POST /api/auth/token; acts as the signed-in user. See docs/mobile-app-api.md",
        },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: { code: { type: "string" }, message: { type: "string" }, details: {} },
            },
          },
        },
      },
    },
    security: [{ session: [] }, { appToken: [] }, { apiKey: [] }],
    paths,
  };
}

export async function systemRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  routes: RouteInfo[],
): Promise<void> {
  app.get("/api/health", { config: { summary: "Liveness", tags: ["system"] } }, async () => ({
    status: "ok",
    name: PROJECT_NAME,
    version: PROJECT_VERSION,
    boundaryToleranceSeconds: ctx.repos.settings.get(
      "audio.boundaryToleranceSeconds",
      ctx.config.audio.boundaryToleranceSeconds,
    ),
    uptimeSeconds: Math.round((Date.now() - ctx.startedAt) / 1000),
  }));

  app.get(
    "/api/ready",
    {
      config: {
        summary: "Readiness: DB, worker, Icecast, Stereo Tool, encoders",
        tags: ["system"],
      },
    },
    async (_req, reply) => {
      const checks: Record<string, { ok: boolean; detail?: string }> = {};
      try {
        ctx.repos.db.prepare("SELECT 1").get();
        checks.database = { ok: true };
      } catch (e) {
        checks.database = { ok: false, detail: (e as Error).message };
      }
      const hb = ctx.worker.lastHeartbeat
        ? Math.round((Date.now() - ctx.worker.lastHeartbeat) / 1000)
        : null;
      checks.worker = {
        ok: ctx.worker.connected && hb !== null && hb < 15,
        detail: ctx.worker.connected ? `heartbeat ${hb}s ago` : "not connected",
      };
      const st = ctx.worker.lastState;
      checks.icecast = {
        ok: ctx.sync.lastIcecastPoll?.ok ?? false,
        detail: ctx.sync.lastIcecastPoll?.error ?? ctx.sync.lastIcecastPoll?.at,
      };
      checks.stereotool = {
        ok: !st || !st.stereotool.enabled || st.stereotool.running,
        detail: st?.stereotool.bypassed ? "bypassed" : st?.stereotool.mode,
      };
      const enc = st?.encoders ?? [];
      checks.encoders = {
        ok: enc.length > 0 && enc.every((e) => e.running),
        detail: enc.map((e) => `${e.mount}:${e.running ? "up" : "down"}`).join(" ") || "no status",
      };
      checks.emergency = { ok: !st?.emergency.active, detail: st?.emergency.reason ?? undefined };
      // Ready = can serve control traffic: DB + worker. The rest is reported (degraded) but not fatal.
      const ready = checks.database.ok && checks.worker.ok;
      const degraded = Object.values(checks).some((c) => !c.ok);
      return reply
        .status(ready ? 200 : 503)
        .send({ status: ready ? (degraded ? "degraded" : "ready") : "not_ready", checks });
    },
  );

  // Prometheus collectors refreshed on scrape.
  ctx.metrics.describe("radio_listeners", "Current listeners per mount");
  ctx.metrics.describe("radio_encoder_up", "Encoder process running (1) or not (0)");
  ctx.metrics.describe("radio_queue_depth", "Upcoming items in the playout queue");
  ctx.metrics.collect(() => {
    const st = ctx.worker.lastState;
    ctx.metrics.set("radio_worker_connected", ctx.worker.connected ? 1 : 0);
    ctx.metrics.set("radio_api_uptime_seconds", Math.round((Date.now() - ctx.startedAt) / 1000));
    ctx.metrics.set("radio_worker_uptime_seconds", st?.uptimeSeconds ?? 0);
    ctx.metrics.set("radio_queue_depth", st?.queue.length ?? 0);
    ctx.metrics.set("radio_emergency_active", st?.emergency.active ? 1 : 0);
    ctx.metrics.set("radio_live_active", st?.live.active ? 1 : 0);
    ctx.metrics.set("radio_alerts_active", ctx.repos.alerts.countActive());
    for (const [status, n] of Object.entries(ctx.repos.requests.countByStatus()))
      ctx.metrics.set("radio_requests", n, { status });
    for (const [status, n] of Object.entries(ctx.repos.media.stats()))
      ctx.metrics.set("radio_media", n, { status });
  });

  app.get(
    ctx.config.metrics.path,
    { config: { summary: "Prometheus metrics" } },
    async (req, reply) => {
      if (!ctx.config.metrics.enabled) throw new HttpError(404, "not_found", "metrics disabled");
      const token = process.env.METRICS_TOKEN;
      if (token && req.headers.authorization !== `Bearer ${token}`)
        throw new HttpError(401, "unauthorized", "metrics token required");
      return reply.type("text/plain; version=0.0.4; charset=utf-8").send(ctx.metrics.render());
    },
  );

  app.get("/api/docs", { config: { summary: "OpenAPI document", tags: ["system"] } }, async () =>
    buildOpenApi(routes, ctx),
  );

  app.get("/api/docs/ui", async (_req, reply) => {
    const doc = buildOpenApi(routes, ctx) as {
      paths: Record<string, Record<string, { summary: string; tags: string[] }>>;
    };
    const rows = Object.entries(doc.paths)
      .flatMap(([p, ops]) =>
        Object.entries(ops).map(
          ([m, o]) =>
            `<tr><td><code>${m.toUpperCase()}</code></td><td><code>${p}</code></td><td>${o.tags.join(", ")}</td><td>${o.summary}</td></tr>`,
        ),
      )
      .join("");
    return reply
      .type("text/html")
      .send(
        `<!doctype html><meta charset="utf-8"><title>API</title><style>body{font:14px system-ui;background:#0b0f0e;color:#e5e7eb;padding:2rem}td{padding:.3rem .6rem;border-bottom:1px solid #1f2a25}code{color:#86efac}a{color:#22c55e}</style><h1>${ctx.config.station.name} API</h1><p>Machine-readable: <a href="/api/docs">/api/docs</a> (OpenAPI 3.1). Errors: <code>{ error: { code, message, details } }</code>.</p><table>${rows}</table>`,
      );
  });

  /* ── Live studio uplink relay ─────────────────────────────────────────
   * nginx routes /ws/live straight to the worker in production; this relay
   * covers single-process setups (demo, tests, no nginx). The worker checks
   * the one-time token itself. */
  const relayLive = (upstreamPath: string) => (socket: WebSocket, req: { url: string }) => {
    const token = new URL(req.url, "http://x").searchParams.get("token") ?? "";
    const port = Number(process.env.PLAYOUT_LIVE_PORT ?? ctx.config.worker.protocolPort + 1);
    const upstream = new WebSocket(
      `ws://127.0.0.1:${port}${upstreamPath}?token=${encodeURIComponent(token)}`,
    );
    const pending: (Buffer | string)[] = [];
    upstream.on("open", () => pending.splice(0).forEach((m) => upstream.send(m)));
    upstream.on(
      "message",
      (data, isBinary) => socket.readyState === 1 && socket.send(data, { binary: isBinary }),
    );
    upstream.on("close", (code) => socket.close(code === 1005 ? 1000 : code));
    upstream.on("error", () => socket.close(1011));
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      const msg = isBinary ? data : data.toString();
      if (upstream.readyState === WebSocket.OPEN) upstream.send(msg);
      else if (upstream.readyState === WebSocket.CONNECTING) pending.push(msg);
    });
    socket.on("close", () => upstream.close());
  };
  app.get("/ws/live", { websocket: true }, relayLive("/live"));
  // Studio monitor (pre-Stereo Tool PCM to the browser).
  app.get("/ws/live/monitor", { websocket: true }, relayLive("/live/monitor"));

  /* ── WebSocket hub (§6.8) ──────────────────────────────────────────── */
  app.get("/ws", { websocket: true }, (socket, req) => {
    const user = req.auth.user;
    const allowed = new Set<Channel>(
      user
        ? (["playout", "live", "alerts", "requests", "stats", "media"] as Channel[]).filter((c) =>
            c === "requests" ? can(user.role, "requests:moderate") : true,
          )
        : [],
    );
    let subscribed = new Set<Channel>(allowed);
    const send = (m: unknown) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(m));
    };
    send({
      type: "hello",
      data: {
        authenticated: Boolean(user),
        channels: [...allowed],
        workerConnected: ctx.worker.connected,
      },
    });
    if (user && ctx.worker.lastState) send({ type: "playout:state", data: ctx.worker.lastState });
    if (!user) {
      // Public sockets get now-playing only.
      subscribed = new Set();
    }
    const unsubscribe = ctx.bus.subscribe((m: BusMessage) => {
      if (subscribed.has(m.channel)) send({ type: m.type, data: m.data });
      else if (!user && m.type === "playout:track-started") {
        const item = (m.data as { item?: { title?: string; artist?: string; kind?: string } }).item;
        send({
          type: "public:now-playing",
          data: {
            title: item?.kind === "news" ? "News" : item?.title,
            artist: item?.kind === "news" ? "" : item?.artist,
          },
        });
      }
    });
    socket.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(String(raw)) as { type?: string; channels?: Channel[] };
        if (msg.type === "ping") send({ type: "pong", data: { ts: Date.now() } });
        if (msg.type === "subscribe" && Array.isArray(msg.channels))
          subscribed = new Set(msg.channels.filter((c) => allowed.has(c)));
      } catch {
        // ignore malformed client messages
      }
    });
    socket.on("close", unsubscribe);
  });
}
