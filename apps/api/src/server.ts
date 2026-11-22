/**
 * radio-api HTTP server (PLAN §4.1, §6.7): Fastify with cookie sessions,
 * CSRF double-submit, RBAC guards, rate limits, multipart uploads, WebSocket
 * hub, security headers, and the built React app served for /admin and /listen.
 */
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AppContext } from "./context.js";
import { CSRF_COOKIE, HttpError, SESSION_COOKIE, sendError } from "./http.js";
import { authRoutes } from "./routes/auth.js";
import { libraryRoutes } from "./routes/library.js";
import { operationsRoutes } from "./routes/operations.js";
import { playoutRoutes } from "./routes/playout.js";
import { publicRoutes } from "./routes/public.js";
import { scheduleRoutes } from "./routes/schedule.js";
import { systemRoutes, type RouteInfo } from "./routes/system.js";

const CSRF_EXEMPT = [
  /^\/api\/auth\/login$/,
  /^\/api\/auth\/password\/(forgot|reset)$/,
  /^\/api\/public\//,
  /^\/api\/triggers\//,
];

export async function buildServer(
  ctx: AppContext,
  options: { webDist?: string; logger?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    // Only the local reverse proxy (nginx) is trusted; a client-supplied X-Forwarded-For
    // from anywhere else is ignored, so rate limits cannot be dodged by spoofing it.
    trustProxy: process.env.TRUST_PROXY ?? "127.0.0.1,::1",
    bodyLimit: 1024 * 1024,
    disableRequestLogging: true,
  });
  const routes: RouteInfo[] = [];
  app.addHook("onRoute", (r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    const cfg = (r.config ?? {}) as { summary?: string; tags?: string[] };
    for (const m of methods)
      routes.push({ method: m, url: r.url, summary: cfg.summary, tags: cfg.tags });
  });

  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: (_req, c) => ({
      statusCode: 429,
      error: "rate_limited",
      message: `too many requests, retry in ${Math.ceil(c.ttl / 1000)} s`,
    }),
  });
  await app.register(multipart, { limits: { fileSize: 500 * 1024 * 1024, files: 1 } });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.decorateRequest("auth", null as never);
  app.addHook("onRequest", async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    const session = ctx.auth.resolveSession(token);
    const keyHeader =
      (req.headers["x-api-key"] as string | undefined) ??
      /^Bearer (rk_\S+)$/.exec(req.headers.authorization ?? "")?.[1] ??
      undefined;
    req.auth = {
      user: session?.user ?? null,
      sessionId: session?.sessionId ?? null,
      csrf: session?.csrf ?? null,
      apiKey: session ? null : ctx.auth.resolveApiKey(keyHeader),
    };
    // CSRF: cookie-authenticated mutations must echo the token (header == cookie == session-bound value).
    if (
      session &&
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !CSRF_EXEMPT.some((r) => r.test(req.url.split("?")[0]!))
    ) {
      const header = req.headers["x-csrf-token"];
      if (header !== session.csrf || req.cookies[CSRF_COOKIE] !== session.csrf)
        throw new HttpError(403, "csrf_failed", "missing or invalid CSRF token");
    }
  });

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
    if (!req.url.startsWith("/api/public/")) reply.header("x-frame-options", "DENY");
    if (req.url.startsWith("/api/") && !reply.hasHeader("cache-control"))
      reply.header("cache-control", "no-store");
    return payload;
  });

  app.setErrorHandler((error, _req, reply) => sendError(reply, error, ctx.log));

  await systemRoutes(app, ctx, routes);
  await authRoutes(app, ctx);
  await libraryRoutes(app, ctx);
  await scheduleRoutes(app, ctx);
  await playoutRoutes(app, ctx);
  await operationsRoutes(app, ctx);
  await publicRoutes(app, ctx);

  // Built SPA (production). nginx serves it directly in the default deployment; this keeps a single-process option.
  const dist = options.webDist ?? join(ctx.config.rootDir, "apps/web/dist");
  if (existsSync(join(dist, "index.html"))) {
    await app.register(fastifyStatic, { root: dist, prefix: "/", wildcard: false, index: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/ws"))
        return reply.status(404).send({
          error: {
            code: "not_found",
            message: `No route for ${req.method} ${req.url.split("?")[0]}`,
          },
        });
      return reply.type("text/html").sendFile("index.html");
    });
  } else {
    app.setNotFoundHandler((req, reply) =>
      reply.status(404).send({
        error: {
          code: "not_found",
          message: `No route for ${req.method} ${req.url.split("?")[0]}`,
        },
      }),
    );
  }
  return app;
}
