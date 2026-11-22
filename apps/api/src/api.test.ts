import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { hashPassword, sha256 } from "@radio/db";
import type { PlayoutState } from "@radio/shared";
import { ProtocolServer } from "../../playout/src/protocol/server.js";
import { createContext, type AppContext } from "./context.js";
import { buildServer } from "./server.js";
import { totp } from "./services/totp.js";
import { createTestEnv, makeTone, type TestEnv } from "./test-utils.js";

let env: TestEnv;
let ctx: AppContext;
let app: FastifyInstance;
let fake: ProtocolServer;
const commands: { type: string; payload: unknown }[] = [];

const fakeState = (): PlayoutState => ({
  mode: "autoplay",
  paused: false,
  stopped: false,
  nowPlaying: {
    uid: "u1",
    kind: "music",
    mediaId: null,
    path: "/x.mp3",
    title: "Song",
    artist: "Band",
    duration: 200,
    cueIn: 0,
    cueOut: null,
    fadeIn: 0,
    fadeOut: 0,
    gainDb: 0,
    planId: null,
    planItemId: null,
    plannedStart: null,
    locked: false,
    source: "automation",
    requestId: null,
    artworkUrl: null,
    startedAt: Date.now(),
    position: 10,
  },
  queue: [],
  history: [],
  fader: 1,
  monitor: false,
  voiceOver: { active: false, title: null },
  event: { active: false, id: null, title: null, priority: 0 },
  live: {
    active: false,
    mode: "duck",
    source: null,
    userId: null,
    sessionId: null,
    startedAt: null,
    recording: false,
    gainDb: 0,
    inputPeakDb: -120,
  },
  emergency: { active: false, reason: null, since: null },
  encoders: [
    {
      mount: "hq.mp3",
      codec: "mp3",
      bitrate: "320k",
      running: true,
      restarts: 0,
      uptimeSeconds: 10,
      queuedMs: 0,
      lastError: null,
    },
  ],
  stereotool: {
    enabled: true,
    running: true,
    bypassed: false,
    mode: "mock",
    edition: "mock",
    restarts: 0,
    error: null,
  },
  boundaryLog: [],
  currentPlan: { planId: null, date: null, hour: null },
  uptimeSeconds: 5,
  sampleClock: 0,
});

interface Session {
  cookie: string;
  csrf: string;
}

let ipCounter = 0;
async function login(username: string, password: string, totpCode?: string): Promise<Session> {
  ipCounter += 1;
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress: `10.1.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`,
    payload: { login: username, password, totp: totpCode },
  });
  expect(res.statusCode, res.body).toBe(200);
  const cookies = res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  return { cookie: cookies, csrf: res.json().csrf };
}

function as(
  s: Session,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    payload: payload as never,
    headers: { cookie: s.cookie, "x-csrf-token": s.csrf },
  });
}

let admin: Session;
let dj: Session;
let operator: Session;

beforeAll(async () => {
  env = await createTestEnv({ admin: true });
  fake = new ProtocolServer((type, payload) => {
    commands.push({ type, payload });
    if (type === "live:stop") return { ...fakeState().live, recordedPath: null };
    return fakeState();
  });
  await fake.listen({ port: 0 });
  env.repos.db.close();
  ctx = await createContext(env.config, {
    log: () => {},
    workerEndpoint: { port: fake.port },
    fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
  });
  app = await buildServer(ctx, { webDist: "/nonexistent" });
  ctx.worker.start();
  await new Promise((r) => setTimeout(r, 150));
  for (const [username, role] of [
    ["dj1", "dj"],
    ["op1", "operator"],
  ] as const) {
    ctx.repos.users.create({
      username,
      email: `${username}@example.org`,
      role,
      passwordHash: await hashPassword("password-12345"),
    });
  }
  admin = await login("admin", "admin-password-123");
  dj = await login("dj1", "password-12345");
  operator = await login("op1", "password-12345");
}, 30_000);

afterAll(async () => {
  await app.close();
  await ctx.close();
  await fake.close();
  env.cleanup();
});

describe("system", () => {
  it("health and readiness", async () => {
    expect((await app.inject({ url: "/api/health" })).json()).toMatchObject({
      status: "ok",
      name: "online-radio-player",
    });
    const ready = await app.inject({ url: "/api/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().checks.worker.ok).toBe(true);
  });

  it("serves an OpenAPI document covering the public API", async () => {
    const doc = (await app.inject({ url: "/api/docs" })).json();
    expect(doc.openapi).toBe("3.1.0");
    for (const p of [
      "/api/public/now-playing",
      "/api/public/schedule",
      "/api/public/history",
      "/api/public/requests",
      "/api/public/stats",
      "/api/playout/skip",
    ])
      expect(doc.paths[p], p).toBeTruthy();
    expect(Object.keys(doc.paths).length).toBeGreaterThan(80);
  });

  it("rejects oversized arrays before validation and caps returned issues", async () => {
    const huge = await as(admin, "POST", "/api/media/duplicates/merge", {
      keepId: 1,
      removeIds: Array(30_000).fill("x"),
    });
    expect(huge.statusCode).toBe(400);
    expect(huge.json().error.message).toMatch(/limited to 20000/);
    const bad = await as(admin, "POST", "/api/media/duplicates/merge", {
      keepId: 1,
      removeIds: Array(900).fill("x"),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.details.length).toBeLessThanOrEqual(20);
  });

  it("exposes Prometheus metrics", async () => {
    const res = await app.inject({ url: "/metrics" });
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.body).toMatch(/# TYPE radio_worker_connected gauge\nradio_worker_connected 1/);
  });

  it("returns the error envelope for unknown routes", async () => {
    const res = await app.inject({ url: "/api/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });
});

describe("auth (M7.1/M7.2)", () => {
  it("rejects wrong passwords and deactivated users, audits failures", async () => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { login: "admin", password: "nope" },
        })
      ).statusCode,
    ).toBe(401);
    const u = ctx.repos.users.create({
      username: "gone",
      email: "gone@example.org",
      role: "dj",
      passwordHash: await hashPassword("password-12345"),
      isActive: false,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { login: "gone", password: "password-12345" },
    });
    expect(res.statusCode).toBe(403);
    expect(ctx.repos.audit.list({ action: "auth.login_failed" }).total).toBeGreaterThanOrEqual(2);
    expect(u.id).toBeGreaterThan(0);
  });

  it("sets HttpOnly session + readable CSRF cookies and returns the user", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { login: "admin@localhost.localdomain", password: "admin-password-123" },
    });
    const session = res.cookies.find((c) => c.name === "radio_session")!;
    expect(session.httpOnly).toBe(true);
    expect(session.sameSite).toBe("Lax");
    expect(res.cookies.find((c) => c.name === "radio_csrf")!.httpOnly).toBeFalsy();
    expect(res.json().user).not.toHaveProperty("password_hash");
  });

  it("requires the CSRF token for cookie-authenticated mutations", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/playout/skip",
      headers: { cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("csrf_failed");
    expect((await as(admin, "POST", "/api/playout/skip")).statusCode).toBe(200);
  });

  it("revokes a stolen session on logout", async () => {
    const s = await login("op1", "password-12345");
    expect((await as(s, "GET", "/api/auth/me")).statusCode).toBe(200);
    await as(s, "POST", "/api/auth/logout");
    expect((await as(s, "GET", "/api/auth/me")).statusCode).toBe(401);
  });

  it("rate-limits login attempts", async () => {
    let limited = false;
    for (let i = 0; i < 15 && !limited; i += 1) {
      const r = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress: "10.9.9.9",
        payload: { login: "x", password: "y" },
      });
      limited = r.statusCode === 429;
    }
    expect(limited).toBe(true);
  });
});

describe("RBAC (M7.3)", () => {
  it.each([
    ["dj", "GET", "/api/admin/users", 403],
    ["dj", "PATCH", "/api/settings", 403],
    ["dj", "POST", "/api/playout/skip", 200],
    ["operator", "GET", "/api/admin/users", 403],
    ["operator", "POST", "/api/media/import", 202],
    ["operator", "PATCH", "/api/settings", 403],
    ["admin", "GET", "/api/admin/users", 200],
  ] as const)("%s %s %s → %i", async (role, method, url, status) => {
    const s = role === "dj" ? dj : role === "operator" ? operator : admin;
    const res = await as(s, method, url, method === "PATCH" ? { settings: {} } : undefined);
    expect(res.statusCode, res.body).toBe(status);
  });

  it("anonymous requests are rejected", async () => {
    expect((await app.inject({ url: "/api/playout/state" })).statusCode).toBe(401);
  });
});

describe("2FA + password reset (M7.4/M7.5)", () => {
  it("requires TOTP once enabled; recovery codes work exactly once", async () => {
    const s = await login("op1", "password-12345");
    const setup = (await as(s, "POST", "/api/auth/2fa/setup")).json();
    const enable = await as(s, "POST", "/api/auth/2fa/enable", { code: totp(setup.secret) });
    expect(enable.statusCode).toBe(200);
    const codes: string[] = enable.json().recoveryCodes;
    expect(codes).toHaveLength(10);
    const noCode = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { login: "op1", password: "password-12345" },
    });
    expect(noCode.json().error.code).toBe("totp_required");
    await login("op1", "password-12345", totp(setup.secret));
    await login("op1", "password-12345", codes[0]);
    const reuse = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { login: "op1", password: "password-12345", totp: codes[0] },
    });
    expect(reuse.statusCode).toBe(401);
    const s2 = await login("op1", "password-12345", totp(setup.secret));
    expect(
      (await as(s2, "POST", "/api/auth/2fa/disable", { password: "password-12345" })).statusCode,
    ).toBe(200);
    await login("op1", "password-12345");
  });

  it("emails a one-time reset link that expires", async () => {
    await app.inject({
      method: "POST",
      url: "/api/auth/password/forgot",
      payload: { email: "dj1@example.org" },
    });
    const mail = ctx.mailer.outbox.at(-1)!;
    expect(mail.to).toEqual(["dj1@example.org"]);
    const token = /token=([\w-]+)/.exec(mail.text)![1]!;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/password/reset",
          payload: { token, password: "brand-new-pass-1" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/password/reset",
          payload: { token, password: "another-pass-123" },
        })
      ).statusCode,
    ).toBe(400);
    dj = await login("dj1", "brand-new-pass-1");
    // Expired token.
    await app.inject({
      method: "POST",
      url: "/api/auth/password/forgot",
      payload: { email: "dj1@example.org" },
    });
    const t2 = /token=([\w-]+)/.exec(ctx.mailer.outbox.at(-1)!.text)![1]!;
    ctx.repos.db
      .prepare("UPDATE password_resets SET expires_at = '2000-01-01' WHERE token_hash = ?")
      .run(sha256(t2));
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/password/reset",
          payload: { token: t2, password: "another-pass-123" },
        })
      ).statusCode,
    ).toBe(400);
    // Unknown email: same response, no mail.
    const before = ctx.mailer.outbox.length;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/password/forgot",
          payload: { email: "nobody@example.org" },
        })
      ).statusCode,
    ).toBe(200);
    expect(ctx.mailer.outbox.length).toBe(before);
  });
});

describe("API keys + triggers (M7.7/M6.6)", () => {
  it("fires a trigger with a scoped key; revoked or unscoped keys are rejected", async () => {
    await as(admin, "PUT", "/api/admin/triggers", {
      items: [{ id: "deck-skip", label: "Skip", action: "skip" }],
    });
    const key = (
      await as(admin, "POST", "/api/admin/api-keys", {
        name: "streamdeck",
        scopes: ["triggers:fire"],
      })
    ).json();
    const readKey = (
      await as(admin, "POST", "/api/admin/api-keys", { name: "reader", scopes: ["read"] })
    ).json();
    const fire = await app.inject({
      method: "POST",
      url: "/api/triggers/deck-skip",
      headers: { "x-api-key": key.key },
    });
    expect(fire.statusCode, fire.body).toBe(200);
    expect(commands.at(-1)).toMatchObject({ type: "trigger:fire", payload: { action: "skip" } });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/triggers/deck-skip",
          headers: { "x-api-key": readKey.key },
        })
      ).statusCode,
    ).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/triggers/deck-skip" })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          url: "/api/playout/state",
          headers: { authorization: `Bearer ${readKey.key}` },
        })
      ).statusCode,
    ).toBe(200);
    await as(admin, "DELETE", `/api/admin/api-keys/${key.id}`);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/triggers/deck-skip",
          headers: { "x-api-key": key.key },
        })
      ).statusCode,
    ).toBe(401);
    const listed = (await as(admin, "GET", "/api/admin/api-keys")).json().items;
    expect(listed[0]).not.toHaveProperty("key_hash");
  });
});

describe("playout control + audit (M6.1/M6.3)", () => {
  it("forwards commands to the worker, returns state and audits every action", async () => {
    commands.length = 0;
    for (const [url, payload, type] of [
      ["/api/playout/pause", undefined, "pause"],
      ["/api/playout/resume", undefined, "resume"],
      ["/api/playout/seek", { position: 30 }, "seek"],
      ["/api/playout/queue/move", { uid: "a", toIndex: 2 }, "queue:move"],
      ["/api/playout/replay-last", undefined, "replay_last"],
      ["/api/playout/emergency", { action: "trigger", reason: "test" }, "emergency:trigger"],
    ] as const) {
      const res = await as(operator, "POST", url, payload);
      expect(res.statusCode, `${url} ${res.body}`).toBe(200);
      expect(res.json().state.mode).toBe("autoplay");
      expect(commands.at(-1)!.type).toBe(type);
    }
    const fader = await as(operator, "PATCH", "/api/playout/fader", { value: 0.8 });
    expect(fader.statusCode).toBe(200);
    const auditRows = ctx.repos.audit.list({ action: "playout." }).items;
    expect(
      auditRows.some(
        (a) =>
          a.action === "playout.seek" &&
          (a.metadata as { position: number }).position === 30 &&
          a.username === "op1",
      ),
    ).toBe(true);
    expect(auditRows.every((a) => a.ip)).toBe(true);
  });

  it("validates payloads", async () => {
    expect((await as(operator, "POST", "/api/playout/seek", { position: -5 })).statusCode).toBe(
      400,
    );
    expect((await as(operator, "PATCH", "/api/playout/fader", { value: 9 })).statusCode).toBe(400);
  });

  it("queue insert / play-now resolve media", async () => {
    const m = ctx.repos.media.upsert({
      path: "/lib/j.mp3",
      title: "Jingle",
      artist: "Station",
      duration: 5,
      status: "ok",
    }).row;
    expect(
      (await as(operator, "POST", "/api/playout/play-now", { mediaId: m.id })).statusCode,
    ).toBe(200);
    expect(
      (commands.at(-1)!.payload as { item: { mediaId: number; kind: string } }).item,
    ).toMatchObject({ mediaId: m.id, kind: "stinger" });
    expect(
      (await as(operator, "POST", "/api/playout/queue/insert", { mediaId: 99999 })).statusCode,
    ).toBe(404);
  });
});

describe("requests (M6.4/M11.3)", () => {
  it("moderates, filters profanity, enforces cooldown, blacklist and inserts approved requests", async () => {
    const m = ctx.repos.media.upsert({
      path: "/lib/req.mp3",
      title: "Wish You Were Here",
      artist: "Pink Floyd",
      duration: 300,
      status: "ok",
    }).row;
    const ok = await app.inject({
      method: "POST",
      url: "/api/public/requests",
      remoteAddress: "1.2.3.4",
      payload: { artist: "pink floyd", title: "wish you were here", dedication: "for mum" },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.headers["access-control-allow-origin"]).toBe("*");
    const req = ok.json().request;
    expect(req.status).toBe("pending");
    const again = await app.inject({
      method: "POST",
      url: "/api/public/requests",
      remoteAddress: "1.2.3.4",
      payload: { title: "Another" },
    });
    expect(again.statusCode).toBe(429);
    expect(Number(again.headers["retry-after"])).toBeGreaterThan(0);
    const dirty = await app.inject({
      method: "POST",
      url: "/api/public/requests",
      remoteAddress: "5.6.7.8",
      payload: { title: "Song", message: "this is sh1t" },
    });
    expect(dirty.json().error.code).toBe("profanity");
    await as(operator, "POST", "/api/requests/blacklist", { pattern: "Baby Shark" });
    const black = await app.inject({
      method: "POST",
      url: "/api/public/requests",
      remoteAddress: "9.9.9.1",
      payload: { artist: "Pinkfong", title: "Baby Shark" },
    });
    expect(black.json().error.code).toBe("blacklisted");
    const queue = (await as(dj, "GET", "/api/requests?status=pending")).json();
    expect(queue.items[0], JSON.stringify(queue)).toBeTruthy();
    expect(queue.items[0].media?.id).toBe(m.id);
    const approved = await as(dj, "POST", `/api/requests/${req.id}/play-next`);
    expect(approved.statusCode, approved.body).toBe(200);
    expect(commands.at(-1)).toMatchObject({
      type: "insert_request",
      payload: { target: "play_next", item: { requestId: req.id, mediaId: m.id } },
    });
    expect(
      (await app.inject({ url: `/api/public/requests/${req.id}` })).json().request.status,
    ).toBe("approved");
    // Worker reports the track started → played.
    ctx.sync.onWorkerEvent("track_started", {
      item: {
        uid: "x",
        kind: "request",
        mediaId: m.id,
        requestId: req.id,
        source: "request",
        planId: null,
        title: "",
        artist: "",
      },
      startedAt: new Date().toISOString(),
    });
    expect(
      (await app.inject({ url: `/api/public/requests/${req.id}` })).json().request.status,
    ).toBe("played");
    expect(ctx.repos.history.recent(1)[0]!.source).toBe("request");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/public/requests",
          remoteAddress: "8.8.8.8",
          payload: { title: "x", website: "spam" },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("keys request cooldowns on the real client IP, ignoring spoofed X-Forwarded-For", async () => {
    ctx.repos.media.upsert({
      path: "/lib/xff.mp3",
      title: "Spoof Test",
      artist: "XFF",
      duration: 200,
      status: "ok",
    });
    const send = (remoteAddress: string, xff: string) =>
      app.inject({
        method: "POST",
        url: "/api/public/requests",
        remoteAddress,
        headers: { "x-forwarded-for": xff },
        payload: { artist: "XFF", title: "Spoof Test" },
      });
    // Direct client (not the local proxy): its own X-Forwarded-For is ignored.
    expect((await send("2.2.2.2", "7.7.7.7")).statusCode).toBe(201);
    expect((await send("2.2.2.2", "8.8.8.8")).statusCode).toBe(429);
    // Through nginx on loopback: the right-most hop nginx appended is the client.
    expect((await send("127.0.0.1", "6.6.6.6, 3.3.3.3")).statusCode).toBe(201);
    expect((await send("127.0.0.1", "1.1.1.1, 3.3.3.3")).statusCode).toBe(429);
  });
});

describe("settings (M1.5)", () => {
  it("validates, audits old/new values and hot-reloads the worker", async () => {
    commands.length = 0;
    const res = await as(admin, "PATCH", "/api/settings", {
      settings: { "live.duckDb": -15, "requests.maxPerHour": 5 },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      changed: ["live.duckDb", "requests.maxPerHour"],
      workerReloaded: true,
    });
    expect(commands.map((c) => c.type)).toContain("settings:reload");
    const a = ctx.repos.audit
      .list({ action: "settings.update" })
      .items.find((x) => (x.metadata as { key: string }).key === "live.duckDb")!;
    expect(a.metadata).toMatchObject({ old: -12, new: -15 });
    expect(
      (await as(admin, "PATCH", "/api/settings", { settings: { "live.duckDb": 50 } })).statusCode,
    ).toBe(400);
    expect(
      (await as(admin, "PATCH", "/api/settings", { settings: { "nope.key": 1 } })).statusCode,
    ).toBe(400);
  });
});

describe("media upload (M2.6)", () => {
  it("accepts audio, rejects disguised files", async () => {
    const mp3 = makeTone(join(env.dir, "up/Upload - Test.mp3"), {
      seconds: 2,
      title: "Uploaded",
      artist: "Tester",
    });
    const boundary = "----radio";
    const body = (name: string, data: Buffer) =>
      Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: audio/mpeg\r\n\r\n`,
        ),
        data,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
    const headers = {
      cookie: operator.cookie,
      "x-csrf-token": operator.csrf,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    };
    const res = await app.inject({
      method: "POST",
      url: "/api/media/upload",
      headers,
      payload: body("Upload - Test.mp3", readFileSync(mp3)),
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().media).toMatchObject({ title: "Uploaded", artist: "Tester", status: "ok" });
    const fake = await app.inject({
      method: "POST",
      url: "/api/media/upload",
      headers,
      payload: body("evil.mp3", Buffer.from("<?php system($_GET['x']); ?>")),
    });
    expect(fake.statusCode).toBe(415);
    const exe = await app.inject({
      method: "POST",
      url: "/api/media/upload",
      headers,
      payload: body("tool.exe", Buffer.from("MZ")),
    });
    expect(exe.statusCode).toBe(415);
    const art = await app.inject({ url: `/api/media/${res.json().media.id}/artwork` });
    expect(art.headers["content-type"]).toMatch(/svg/);
  });
});

describe("public API (M11.2/M11.4)", () => {
  it("now-playing, schedule and history are public and CORS-enabled", async () => {
    const np = await app.inject({ url: "/api/public/now-playing" });
    expect(np.statusCode).toBe(200);
    expect(np.json()).toMatchObject({
      nowPlaying: { title: "Song", artist: "Band" },
      streams: { mounts: expect.any(Array) },
    });
    const sched = await app.inject({ url: "/api/public/schedule" });
    expect(sched.json().hours).toHaveLength(24);
    expect((await app.inject({ url: "/api/public/history" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/public/stats" })).statusCode).toBe(401);
    const key = (
      await as(admin, "POST", "/api/admin/api-keys", { name: "partner", scopes: ["public:stats"] })
    ).json();
    expect(
      (await app.inject({ url: "/api/public/stats", headers: { "x-api-key": key.key } })).json(),
    ).toHaveProperty("listeners");
  });
});

describe("events (M6.5)", () => {
  it("creates and starts a playlist event with a priority", async () => {
    const pl = ctx.repos.playlists.getByName("Jingles")!;
    const m = ctx.repos.media.upsert({
      path: "/lib/ev.mp3",
      title: "Ev",
      artist: "E",
      duration: 30,
      status: "ok",
    }).row;
    ctx.repos.playlists.addItems(pl.id, [m.id]);
    const created = await as(operator, "POST", "/api/events", {
      title: "Special",
      type: "playlist",
      startAt: new Date(Date.now() + 3_600_000).toISOString(),
      endAt: new Date(Date.now() + 7_200_000).toISOString(),
      priority: 8,
      playlistId: pl.id,
    });
    expect(created.statusCode, created.body).toBe(201);
    const started = await as(operator, "POST", `/api/events/${created.json().event.id}/start`);
    expect(started.statusCode, started.body).toBe(200);
    expect(commands.at(-1)).toMatchObject({
      type: "event:start",
      payload: { priority: 8, title: "Special" },
    });
    expect(started.json().event.status).toBe("active");
  });
});

describe("stats export", () => {
  it("exports CSV with formula injection neutralized", async () => {
    const m = ctx.repos.media.upsert({
      path: "/lib/csv.mp3",
      title: "=HYPERLINK(1)",
      artist: "A,B",
      duration: 10,
      status: "ok",
    }).row;
    ctx.repos.history.start({
      mediaId: m.id,
      planId: null,
      startedAt: new Date().toISOString(),
      source: "automation",
    });
    const res = await as(operator, "GET", "/api/stats/export?type=history");
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.body).toContain("'=HYPERLINK(1)");
    expect(res.body).toContain('"A,B"');
  });
});

describe("WebSocket (M6.2)", () => {
  it("delivers bus events to an authenticated client in < 200 ms", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: admin.cookie } });
    const msgs: { type: string }[] = [];
    ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once("open", r));
    await new Promise((r) => setTimeout(r, 100));
    expect(msgs[0]).toMatchObject({ type: "hello", data: { authenticated: true } });
    const t0 = Date.now();
    ctx.sync.onWorkerEvent("now_playing", { title: "Live update" });
    while (!msgs.some((m) => m.type === "playout:now-playing") && Date.now() - t0 < 1000)
      await new Promise((r) => setTimeout(r, 5));
    expect(Date.now() - t0).toBeLessThan(200);
    ws.close();
    const anon = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const first = await new Promise<{ data: { authenticated: boolean; channels: string[] } }>((r) =>
      anon.once("message", (d) => r(JSON.parse(String(d)))),
    );
    expect(first.data).toMatchObject({ authenticated: false, channels: [] });
    anon.close();
  });
});

describe("readiness (M12.6)", () => {
  it("fails while the worker is down and recovers when it comes back", async () => {
    const port = fake.port;
    await fake.close();
    const t0 = Date.now();
    while (ctx.worker.connected && Date.now() - t0 < 5000)
      await new Promise((r) => setTimeout(r, 50));
    const down = await app.inject({ url: "/api/ready" });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({ status: "not_ready", checks: { worker: { ok: false } } });
    fake = new ProtocolServer((type, payload) => {
      commands.push({ type, payload });
      return fakeState();
    });
    await fake.listen({ port });
    const t1 = Date.now();
    while (!ctx.worker.connected && Date.now() - t1 < 15_000)
      await new Promise((r) => setTimeout(r, 100));
    const up = await app.inject({ url: "/api/ready" });
    expect(up.statusCode).toBe(200);
    expect(up.json().checks.worker.ok).toBe(true);
  }, 30_000);
});
