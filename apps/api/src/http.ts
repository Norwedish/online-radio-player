/** Shared HTTP helpers: auth context, permission guards, CSRF, audit, errors. */
import type { FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import type { PublicUser } from "@radio/db";
import { can, type Permission } from "@radio/shared";
import type { AppContext } from "./context.js";
import { AuthError } from "./services/auth.js";
import { RequestError } from "./services/requests.js";
import { WorkerUnavailableError } from "./worker-client.js";

export const SESSION_COOKIE = "radio_session";
export const CSRF_COOKIE = "radio_csrf";

export interface AuthState {
  user: PublicUser | null;
  sessionId: number | null;
  csrf: string | null;
  apiKey: { id: number; scopes: string[]; name: string } | null;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthState;
  }
  interface FastifyContextConfig {
    /** OpenAPI summary for /api/docs. */
    summary?: string;
    tags?: string[];
  }
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = "resource") => new HttpError(404, "not_found", `${what} not found`);

/** preHandler: require a logged-in user with `permission` (or an API key with `scope`). */
export function guard(permission?: Permission, apiScope?: string) {
  return async (req: FastifyRequest) => {
    if (req.auth.user) {
      if (permission && !can(req.auth.user.role, permission))
        throw new HttpError(403, "forbidden", `role ${req.auth.user.role} lacks ${permission}`);
      return;
    }
    if (apiScope && req.auth.apiKey?.scopes.includes(apiScope)) return;
    throw new HttpError(401, "unauthorized", "login required");
  };
}

export function actor(req: FastifyRequest): { userId: number | null; ip: string } {
  return { userId: req.auth.user?.id ?? null, ip: req.ip };
}

export function audit(
  ctx: AppContext,
  req: FastifyRequest,
  action: string,
  entityType?: string | null,
  entityId?: number | null,
  metadata?: unknown,
): void {
  ctx.repos.audit.write({
    userId: req.auth.user?.id ?? null,
    action,
    entityType: entityType ?? null,
    entityId: entityId ?? null,
    metadata: req.auth.apiKey
      ? { ...(metadata as object | undefined), apiKey: req.auth.apiKey.name }
      : metadata,
    ip: req.ip,
  });
}

export function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  return schema.parse(value ?? {});
}

export const idParam = z.object({ id: z.coerce.number().int().positive() });

export function sendError(
  reply: FastifyReply,
  error: unknown,
  log: (m: string) => void,
): FastifyReply {
  if (error instanceof ZodError) {
    return reply.status(400).send({
      error: {
        code: "validation_error",
        message: "invalid request",
        details: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    });
  }
  if (error instanceof HttpError)
    return reply
      .status(error.statusCode)
      .send({ error: { code: error.code, message: error.message, details: error.details } });
  if (error instanceof AuthError)
    return reply
      .status(error.statusCode)
      .send({ error: { code: error.code, message: error.message } });
  if (error instanceof RequestError) {
    if (error.retryAfterSeconds) reply.header("retry-after", String(error.retryAfterSeconds));
    return reply
      .status(error.statusCode)
      .send({ error: { code: error.code, message: error.message } });
  }
  if (error instanceof WorkerUnavailableError)
    return reply
      .status(503)
      .send({ error: { code: "worker_unavailable", message: error.message } });
  const e = error as {
    statusCode?: number;
    code?: string;
    message?: string;
    details?: unknown;
    validation?: unknown;
  };
  if (e.statusCode === 429)
    return reply
      .status(429)
      .send({ error: { code: "rate_limited", message: e.message ?? "too many requests" } });
  if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
    return reply.status(e.statusCode).send({
      error: {
        code: typeof e.code === "string" && !e.code.startsWith("FST_") ? e.code : "bad_request",
        message: e.message ?? "bad request",
        details: e.details,
      },
    });
  }
  if (
    e.message &&
    /timed out|worker error|item not in queue|locked items|nothing (playing|to replay)|already active|is active|position beyond/.test(
      e.message,
    )
  ) {
    return reply.status(409).send({ error: { code: "playout_rejected", message: e.message } });
  }
  log(`unhandled error: ${(error as Error)?.stack ?? String(error)}`);
  return reply
    .status(500)
    .send({ error: { code: "internal_error", message: "internal server error" } });
}
