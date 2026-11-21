import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { DEFAULT_BOUNDARY_TOLERANCE_SECONDS } from "@radio/core";
import { PROJECT_NAME, PROJECT_VERSION } from "@radio/shared";

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

/**
 * M0 scaffold: native HTTP health/readiness endpoints.
 * M6 replaces this with Fastify routes, WebSocket and auth.
 */
export function createApp() {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      json(res, 200, {
        status: "ok",
        name: PROJECT_NAME,
        version: PROJECT_VERSION,
        boundaryToleranceSeconds: DEFAULT_BOUNDARY_TOLERANCE_SECONDS,
        uptimeSeconds: Math.round(process.uptime()),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/ready") {
      json(res, 200, { status: "ready", checks: { api: "ok" } });
      return;
    }

    json(res, 404, {
      error: {
        code: "not_found",
        message: `No route for ${req.method ?? "GET"} ${url.pathname}`,
      },
    });
  });
}
