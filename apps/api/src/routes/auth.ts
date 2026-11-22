/** Auth, users, API keys, audit log (PLAN §6.7, M7). */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { hashPassword, toPublicUser } from "@radio/db";
import { API_KEY_SCOPES, ROLES } from "@radio/shared";
import type { AppContext } from "../context.js";
import {
  CSRF_COOKIE,
  HttpError,
  SESSION_COOKIE,
  audit,
  guard,
  idParam,
  notFound,
  parse,
} from "../http.js";

function setSessionCookies(
  req: FastifyRequest,
  reply: FastifyReply,
  token: string,
  csrf: string,
  expiresAt: string,
): void {
  const secure = req.protocol === "https";
  const expires = new Date(expiresAt);
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
    expires,
  });
  reply.setCookie(CSRF_COOKIE, csrf, {
    path: "/",
    httpOnly: false,
    sameSite: "lax",
    secure,
    expires,
  });
}

function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
  reply.clearCookie(CSRF_COOKIE, { path: "/" });
}

export async function authRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const loginLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

  app.post(
    "/api/auth/login",
    {
      ...loginLimit,
      config: {
        ...loginLimit.config,
        summary: "Login (username/email + password, optional TOTP)",
        tags: ["auth"],
      },
    },
    async (req, reply) => {
      const body = parse(
        z.object({
          login: z.string().min(1).max(200),
          password: z.string().min(1).max(256),
          totp: z.string().max(20).optional(),
        }),
        req.body,
      );
      try {
        const result = await ctx.auth.login({
          ...body,
          ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
        });
        setSessionCookies(req, reply, result.token, result.csrf, result.expiresAt);
        ctx.repos.audit.write({
          userId: result.user.id,
          action: "auth.login",
          entityType: "user",
          entityId: result.user.id,
          ip: req.ip,
        });
        return { user: result.user, csrf: result.csrf, expiresAt: result.expiresAt };
      } catch (e) {
        ctx.repos.audit.write({
          userId: null,
          action: "auth.login_failed",
          metadata: { login: body.login.slice(0, 100), reason: (e as { code?: string }).code },
          ip: req.ip,
        });
        throw e;
      }
    },
  );

  app.post(
    "/api/auth/logout",
    { config: { summary: "Revoke the current session", tags: ["auth"] } },
    async (req, reply) => {
      if (req.auth.sessionId) {
        ctx.auth.logout(req.auth.sessionId);
        audit(ctx, req, "auth.logout", "user", req.auth.user?.id);
      }
      clearSessionCookies(reply);
      return { ok: true };
    },
  );

  app.post(
    "/api/auth/logout-all",
    { preHandler: guard(), config: { summary: "Revoke all other sessions", tags: ["auth"] } },
    async (req) => {
      const revoked = ctx.auth.logoutEverywhere(req.auth.user!.id, req.auth.sessionId ?? undefined);
      audit(ctx, req, "auth.logout_all", "user", req.auth.user!.id, { revoked });
      return { revoked };
    },
  );

  app.get("/api/auth/me", { config: { summary: "Current user", tags: ["auth"] } }, async (req) => {
    if (!req.auth.user) throw new HttpError(401, "unauthorized", "not logged in");
    return { user: req.auth.user, csrf: req.auth.csrf };
  });

  app.get(
    "/api/auth/sessions",
    { preHandler: guard(), config: { summary: "My active sessions", tags: ["auth"] } },
    async (req) => ({
      items: ctx.repos.sessions.listForUser(req.auth.user!.id).map((s) => ({
        id: s.id,
        ip: s.ip,
        user_agent: s.user_agent,
        created_at: s.created_at,
        expires_at: s.expires_at,
        current: s.id === req.auth.sessionId,
      })),
    }),
  );

  app.post(
    "/api/auth/password/change",
    { preHandler: guard(), config: { summary: "Change my password", tags: ["auth"] } },
    async (req) => {
      const body = parse(z.object({ current: z.string(), next: z.string() }), req.body);
      await ctx.auth.changePassword(
        req.auth.user!.id,
        body.current,
        body.next,
        req.auth.sessionId ?? undefined,
      );
      audit(ctx, req, "auth.password_change", "user", req.auth.user!.id);
      return { ok: true };
    },
  );

  app.post(
    "/api/auth/password/forgot",
    {
      config: {
        rateLimit: { max: 5, timeWindow: "15 minutes" },
        summary: "Request a reset email",
        tags: ["auth"],
      },
    },
    async (req) => {
      const body = parse(z.object({ email: z.string().email().max(200) }), req.body);
      const base = `${req.protocol}://${req.headers.host ?? ctx.config.station.domain}`;
      const token = await ctx.auth.forgotPassword(body.email, process.env.PUBLIC_BASE_URL ?? base);
      ctx.repos.audit.write({
        userId: null,
        action: "auth.password_forgot",
        metadata: { email: body.email.slice(0, 100), matched: token !== null },
        ip: req.ip,
      });
      return { ok: true };
    },
  );

  app.post(
    "/api/auth/password/reset",
    {
      config: {
        rateLimit: { max: 10, timeWindow: "15 minutes" },
        summary: "Reset password with a token",
        tags: ["auth"],
      },
    },
    async (req) => {
      const body = parse(
        z.object({ token: z.string().min(10).max(200), password: z.string() }),
        req.body,
      );
      const userId = await ctx.auth.resetPassword(body.token, body.password);
      ctx.repos.audit.write({
        userId,
        action: "auth.password_reset",
        entityType: "user",
        entityId: userId,
        ip: req.ip,
      });
      return { ok: true };
    },
  );

  app.post(
    "/api/auth/2fa/setup",
    { preHandler: guard(), config: { summary: "Start TOTP setup", tags: ["auth"] } },
    async (req) => {
      if (!ctx.config.users.totpAllowed) throw new HttpError(403, "forbidden", "2FA is disabled");
      return ctx.auth.setupTotp(req.auth.user!.id);
    },
  );

  app.post(
    "/api/auth/2fa/enable",
    { preHandler: guard(), config: { summary: "Confirm TOTP", tags: ["auth"] } },
    async (req) => {
      const body = parse(z.object({ code: z.string().regex(/^\d{6}$/) }), req.body);
      const result = ctx.auth.enableTotp(req.auth.user!.id, body.code);
      audit(ctx, req, "auth.2fa_enable", "user", req.auth.user!.id);
      return result;
    },
  );

  app.post(
    "/api/auth/2fa/disable",
    { preHandler: guard(), config: { summary: "Disable TOTP", tags: ["auth"] } },
    async (req) => {
      const body = parse(z.object({ password: z.string() }), req.body);
      await ctx.auth.disableTotp(req.auth.user!.id, body.password);
      audit(ctx, req, "auth.2fa_disable", "user", req.auth.user!.id);
      return { ok: true };
    },
  );

  /* ── Users (admin) ─────────────────────────────────────────────────── */

  app.get(
    "/api/admin/users",
    { preHandler: guard("users:manage"), config: { summary: "List users", tags: ["users"] } },
    async () => ({ items: ctx.repos.users.list().map(toPublicUser) }),
  );

  app.post(
    "/api/admin/users",
    { preHandler: guard("users:manage"), config: { summary: "Create user", tags: ["users"] } },
    async (req, reply) => {
      const body = parse(
        z.object({
          username: z.string().regex(/^[a-zA-Z0-9._-]{3,40}$/),
          email: z.string().email(),
          role: z.enum(ROLES),
          password: z.string(),
        }),
        req.body,
      );
      ctx.auth.checkPasswordPolicy(body.password);
      if (ctx.repos.users.findByLogin(body.username) || ctx.repos.users.findByLogin(body.email))
        throw new HttpError(409, "conflict", "username or email already exists");
      const user = ctx.repos.users.create({
        username: body.username,
        email: body.email,
        role: body.role,
        passwordHash: await hashPassword(body.password),
      });
      audit(ctx, req, "user.create", "user", user.id, { username: user.username, role: user.role });
      return reply.status(201).send({ user: toPublicUser(user) });
    },
  );

  app.patch(
    "/api/admin/users/:id",
    {
      preHandler: guard("users:manage"),
      config: { summary: "Update user (role, email, active, password)", tags: ["users"] },
    },
    async (req) => {
      const { id } = parse(idParam, req.params);
      const body = parse(
        z.object({
          email: z.string().email().optional(),
          role: z.enum(ROLES).optional(),
          is_active: z.boolean().optional(),
          password: z.string().optional(),
        }),
        req.body,
      );
      const user = ctx.repos.users.get(id);
      if (!user) throw notFound("user");
      if (
        id === req.auth.user!.id &&
        ((body.role && body.role !== "admin") || body.is_active === false)
      )
        throw new HttpError(409, "conflict", "you cannot demote or deactivate yourself");
      if (body.password) ctx.auth.checkPasswordPolicy(body.password);
      const updated = ctx.repos.users.update(id, {
        ...(body.email ? { email: body.email } : {}),
        ...(body.role ? { role: body.role } : {}),
        ...(body.is_active !== undefined ? { is_active: body.is_active } : {}),
        ...(body.password ? { password_hash: await hashPassword(body.password) } : {}),
      })!;
      if (body.is_active === false || body.password || (body.role && body.role !== user.role))
        ctx.repos.sessions.revokeAllForUser(id);
      audit(ctx, req, "user.update", "user", id, {
        ...body,
        password: body.password ? "(changed)" : undefined,
      });
      return { user: toPublicUser(updated) };
    },
  );

  app.delete(
    "/api/admin/users/:id",
    { preHandler: guard("users:manage"), config: { summary: "Deactivate user", tags: ["users"] } },
    async (req) => {
      const { id } = parse(idParam, req.params);
      if (id === req.auth.user!.id)
        throw new HttpError(409, "conflict", "you cannot deactivate yourself");
      if (!ctx.repos.users.update(id, { is_active: false })) throw notFound("user");
      ctx.repos.sessions.revokeAllForUser(id);
      audit(ctx, req, "user.deactivate", "user", id);
      return { ok: true };
    },
  );

  /* ── API keys (admin) ─────────────────────────────────────────────── */

  app.get(
    "/api/admin/api-keys",
    { preHandler: guard("apikeys:manage"), config: { summary: "List API keys", tags: ["users"] } },
    async () => ({
      items: ctx.repos.apiKeys.list().map(({ key_hash: _h, ...k }) => k),
    }),
  );

  app.post(
    "/api/admin/api-keys",
    {
      preHandler: guard("apikeys:manage"),
      config: { summary: "Create API key (shown once)", tags: ["users"] },
    },
    async (req, reply) => {
      const body = parse(
        z.object({
          name: z.string().min(1).max(80),
          scopes: z.array(z.enum(API_KEY_SCOPES)).min(1),
        }),
        req.body,
      );
      const created = ctx.auth.createApiKey(body.name, body.scopes, req.auth.user!.id);
      audit(ctx, req, "apikey.create", "api_key", created.id, {
        name: body.name,
        scopes: body.scopes,
      });
      return reply.status(201).send(created);
    },
  );

  app.delete(
    "/api/admin/api-keys/:id",
    { preHandler: guard("apikeys:manage"), config: { summary: "Revoke API key", tags: ["users"] } },
    async (req) => {
      const { id } = parse(idParam, req.params);
      if (!ctx.repos.apiKeys.revoke(id)) throw notFound("api key");
      audit(ctx, req, "apikey.revoke", "api_key", id);
      return { ok: true };
    },
  );

  /* ── Audit log ─────────────────────────────────────────────────────── */

  app.get(
    "/api/admin/audit",
    {
      preHandler: guard("audit:view"),
      config: { summary: "Audit log (filterable)", tags: ["users"] },
    },
    async (req) => {
      const q = parse(
        z.object({
          userId: z.coerce.number().int().optional(),
          action: z.string().max(80).optional(),
          entityType: z.string().max(40).optional(),
          since: z.string().optional(),
          until: z.string().optional(),
          limit: z.coerce.number().int().max(1000).optional(),
          offset: z.coerce.number().int().optional(),
        }),
        req.query,
      );
      return ctx.repos.audit.list(q);
    },
  );
}
