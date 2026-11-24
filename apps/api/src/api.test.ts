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

describe("app tokens (remote-control app)", () => {
  // dj1's password was changed by the password-reset test above.
  const DJ_PW = "brand-new-pass-1";
  let tokenIp = 0;
  /** POST /api/auth/token from a fresh client address (the route is rate limited per IP). */
  function token(payload: Record<string, unknown>) {
    tokenIp += 1;
    return app.inject({
      method: "POST",
      url: "/api/auth/token",
      remoteAddress: `10.9.${Math.floor(tokenIp / 250)}.${tokenIp % 250}`,
      payload,
    });
  }
  const bearer = (accessToken: string, method: "GET" | "POST" | "DELETE", url: string) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${accessToken}` } });

  it("password grant: bearer token acts as the user, with RBAC and without CSRF", async () => {
    const res = await token({
      grantType: "password",
      login: "op1",
      password: "password-12345",
      deviceName: "Pixel 9",
      platform: "android",
      appVersion: "1.0.0",
    });
    expect(res.statusCode, res.body).toBe(200);
    const t = res.json();
    expect(t).toMatchObject({
      tokenType: "Bearer",
      expiresIn: 3600,
      refreshExpiresIn: 90 * 86_400,
      user: { username: "op1", role: "operator" },
    });
    expect(t.accessToken).toMatch(/^rat_/);
    expect(t.refreshToken).toMatch(/^rrt_/);
    expect(t.user).not.toHaveProperty("password_hash");
    // Stored hashed only.
    const row = ctx.repos.devices.get(t.deviceId)!;
    expect(row.access_hash).toBe(sha256(t.accessToken));
    expect(JSON.stringify(row)).not.toContain(t.accessToken);

    expect((await bearer(t.accessToken, "GET", "/api/auth/me")).json().user.username).toBe("op1");
    expect((await bearer(t.accessToken, "GET", "/api/playout/state")).statusCode).toBe(200);
    const before = commands.length;
    expect((await bearer(t.accessToken, "POST", "/api/playout/skip")).statusCode).toBe(200);
    expect(commands.slice(before).some((c) => c.type === "skip")).toBe(true);
    expect((await bearer(t.accessToken, "GET", "/api/admin/users")).statusCode).toBe(403);
    // Audited with the device id.
    const entry = ctx.repos.audit
      .list({ action: "playout.skip" })
      .items.find((a) => (a.metadata as { deviceId?: number } | null)?.deviceId === t.deviceId);
    expect(entry).toBeTruthy();
  });

  it("rejects unknown, malformed and wrong-credential requests clearly", async () => {
    const bad = await bearer("rat_not-a-real-token", "GET", "/api/auth/me");
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe("invalid_token");
    expect(
      (await token({ grantType: "password", login: "op1", password: "nope" })).statusCode,
    ).toBe(401);
    expect((await token({ grantType: "magic" })).statusCode).toBe(400);
    expect(
      ctx.repos.audit.list({ action: "auth.token_failed" }).items.length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("refresh rotates both tokens; reusing an old refresh token signs the device out", async () => {
    const first = (await token({ grantType: "password", login: "dj1", password: DJ_PW })).json();
    const second = (
      await token({ grantType: "refresh_token", refreshToken: first.refreshToken })
    ).json();
    expect(second.deviceId).toBe(first.deviceId);
    expect(second.accessToken).not.toBe(first.accessToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect((await bearer(first.accessToken, "GET", "/api/auth/me")).statusCode).toBe(401);
    expect((await bearer(second.accessToken, "GET", "/api/auth/me")).statusCode).toBe(200);

    // The old refresh token shows up again → copied → revoke the device.
    const reuse = await token({ grantType: "refresh_token", refreshToken: first.refreshToken });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().error.code).toBe("token_reused");
    expect((await bearer(second.accessToken, "GET", "/api/auth/me")).statusCode).toBe(401);
    expect(
      (await token({ grantType: "refresh_token", refreshToken: second.refreshToken })).statusCode,
    ).toBe(401);
    expect(ctx.repos.devices.get(first.deviceId)!.revoked_reason).toBe("refresh_token_reused");
    expect(ctx.repos.alerts.list({}).items.some((a) => a.type === "app_token_reused")).toBe(true);
  });

  it("pairs a device with a one-time code from the web console", async () => {
    const pair = await as(operator, "POST", "/api/auth/devices/pair", { name: "Studio tablet" });
    expect(pair.statusCode, pair.body).toBe(201);
    const p = pair.json();
    expect(p.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(JSON.parse(p.qr)).toMatchObject({ type: "radio-remote-pairing", v: 1, code: p.code });
    // Typed by hand: lower case, no dash.
    const res = await token({
      grantType: "pairing_code",
      code: p.code.replace("-", "").toLowerCase(),
      platform: "android",
    });
    expect(res.statusCode, res.body).toBe(200);
    const t = res.json();
    expect(t).toMatchObject({ deviceId: p.deviceId, user: { username: "op1" } });
    expect(ctx.repos.devices.get(p.deviceId)!.name).toBe("Studio tablet");
    // Single use.
    expect((await token({ grantType: "pairing_code", code: p.code })).statusCode).toBe(400);
    // A device cannot mint pairing codes for more devices.
    const fromDevice = await app.inject({
      method: "POST",
      url: "/api/auth/devices/pair",
      headers: { authorization: `Bearer ${t.accessToken}` },
      payload: {},
    });
    expect(fromDevice.statusCode).toBe(403);
    // Listed for the owner, marked as the calling device.
    const list = (await bearer(t.accessToken, "GET", "/api/auth/devices")).json();
    expect(list.items.find((d: { id: number }) => d.id === p.deviceId)).toMatchObject({
      status: "active",
      current: true,
      platform: "android",
    });
    // Signing it out from the console kills its tokens.
    expect((await as(operator, "DELETE", `/api/auth/devices/${p.deviceId}`)).statusCode).toBe(200);
    expect((await bearer(t.accessToken, "GET", "/api/auth/me")).statusCode).toBe(401);
  });

  it("users cannot remove other users' devices; admins can see and remove all", async () => {
    const t = (await token({ grantType: "password", login: "dj1", password: DJ_PW })).json();
    expect((await as(operator, "DELETE", `/api/auth/devices/${t.deviceId}`)).statusCode).toBe(404);
    const all = (await as(admin, "GET", "/api/admin/devices")).json();
    expect(
      all.items.some(
        (d: { id: number; username: string }) => d.id === t.deviceId && d.username === "dj1",
      ),
    ).toBe(true);
    expect((await as(admin, "DELETE", `/api/auth/devices/${t.deviceId}`)).statusCode).toBe(200);
    expect(ctx.repos.devices.get(t.deviceId)!.revoked_reason).toBe("removed_by_admin");
  });

  it("app sign-out works with the access token or with only the refresh token", async () => {
    const a = (await token({ grantType: "password", login: "dj1", password: DJ_PW })).json();
    expect((await bearer(a.accessToken, "POST", "/api/auth/token/revoke")).statusCode).toBe(200);
    expect((await bearer(a.accessToken, "GET", "/api/auth/me")).statusCode).toBe(401);
    const b = (await token({ grantType: "password", login: "dj1", password: DJ_PW })).json();
    const revoke = await app.inject({
      method: "POST",
      url: "/api/auth/token/revoke",
      payload: { refreshToken: b.refreshToken },
    });
    expect(revoke.statusCode).toBe(200);
    expect(
      (await token({ grantType: "refresh_token", refreshToken: b.refreshToken })).statusCode,
    ).toBe(401);
    // Unknown token: still OK (never reveals whether a token existed).
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/token/revoke",
          payload: { refreshToken: "rrt_unknown-token" },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("a password set by an admin signs all of that user's devices out", async () => {
    const t = (await token({ grantType: "password", login: "dj1", password: DJ_PW })).json();
    const dj1 = ctx.repos.users.findByLogin("dj1")!;
    expect(
      (await as(admin, "PATCH", `/api/admin/users/${dj1.id}`, { password: "password-67890" }))
        .statusCode,
    ).toBe(200);
    expect((await bearer(t.accessToken, "GET", "/api/auth/me")).statusCode).toBe(401);
    expect(ctx.repos.devices.get(t.deviceId)!.revoked_reason).toBe("password_set_by_admin");
    await as(admin, "PATCH", `/api/admin/users/${dj1.id}`, { password: DJ_PW });
  });

  it("enforces the per-user device limit and the app-access switch", async () => {
    const u = ctx.repos.users.findByLogin("op1")!;
    ctx.repos.devices.revokeAllForUser(u.id, "test_reset");
    const max = ctx.config.users.appTokens.maxDevicesPerUser;
    for (let i = 0; i < max; i += 1)
      await ctx.devices.signIn({ login: "op1", password: "password-12345", ip: "10.0.0.1" });
    const over = await token({ grantType: "password", login: "op1", password: "password-12345" });
    expect(over.statusCode).toBe(409);
    expect(over.json().error.code).toBe("too_many_devices");
    ctx.repos.devices.revokeAllForUser(u.id, "test_reset");

    const t = (
      await token({ grantType: "password", login: "op1", password: "password-12345" })
    ).json();
    ctx.config.users.appTokens.enabled = false;
    try {
      const off = await token({ grantType: "password", login: "op1", password: "password-12345" });
      expect(off.statusCode).toBe(403);
      expect(off.json().error.code).toBe("app_access_disabled");
      expect((await bearer(t.accessToken, "GET", "/api/auth/me")).statusCode).toBe(401);
    } finally {
      ctx.config.users.appTokens.enabled = true;
    }
  });

  it("expired access tokens are refused; the refresh token still works", async () => {
    const t = (
      await token({ grantType: "password", login: "op1", password: "password-12345" })
    ).json();
    ctx.repos.db
      .prepare("UPDATE device_grants SET access_expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), t.deviceId);
    expect((await bearer(t.accessToken, "GET", "/api/auth/me")).json().error.code).toBe(
      "invalid_token",
    );
    const r = await token({ grantType: "refresh_token", refreshToken: t.refreshToken });
    expect(r.statusCode).toBe(200);
    expect((await bearer(r.json().accessToken, "GET", "/api/auth/me")).statusCode).toBe(200);
  });

  it("authenticates the WebSocket with the bearer header", async () => {
    const t = (
      await token({ grantType: "password", login: "op1", password: "password-12345" })
    ).json();
    if (!app.server.listening) await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { authorization: `Bearer ${t.accessToken}` },
    });
    const hello = await new Promise<{
      type: string;
      data: { authenticated: boolean; channels: string[] };
    }>((r) => ws.once("message", (d) => r(JSON.parse(String(d)))));
    expect(hello).toMatchObject({ type: "hello", data: { authenticated: true } });
    expect(hello.data.channels).toContain("playout");
    ws.close();
  });

  it("documents the bearer scheme and token endpoints in OpenAPI", async () => {
    const doc = (await app.inject({ url: "/api/docs" })).json();
    expect(doc.components.securitySchemes.appToken).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
    expect(doc.paths["/api/auth/token"].post.security).toEqual([]);
    expect(doc.paths["/api/auth/devices/pair"]).toBeTruthy();
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
