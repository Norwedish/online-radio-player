import { createHmac } from "node:crypto";
import { createSocket } from "node:dgram";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "../test-utils.js";
import { AlertService } from "./alerts.js";
import { EventBus, type BusMessage } from "./bus.js";
import { Mailer } from "./mailer.js";

let env: TestEnv;
const udp = createSocket("udp4");
const syslog: string[] = [];
let port = 0;

beforeAll(async () => {
  env = await createTestEnv();
  udp.on("message", (m) => syslog.push(m.toString()));
  await new Promise<void>((r) => udp.bind(0, "127.0.0.1", () => r()));
  port = udp.address().port;
});

afterAll(() => {
  udp.close();
  delete process.env.SYSLOG_HOST;
  delete process.env.SYSLOG_PORT;
  delete process.env.TEST_HOOK_URL;
  delete process.env.TEST_HOOK_SECRET;
  delete process.env.TEST_HOOK2_URL;
  env.cleanup();
});

function setup(dedupeSeconds = 300) {
  process.env.SYSLOG_HOST = "127.0.0.1";
  process.env.SYSLOG_PORT = String(port);
  process.env.TEST_HOOK_URL = "https://hooks.example.test/alert";
  process.env.TEST_HOOK_SECRET = "s3cret";
  process.env.TEST_HOOK2_URL = "https://hooks.example.test/critical-only";
  const config = {
    ...env.config,
    alerts: { ...env.config.alerts, email: true, emailTo: ["ops@example.org"], dedupeSeconds },
    webhooks: {
      alerts: [
        {
          id: "discord",
          urlEnv: "TEST_HOOK_URL",
          minSeverity: "warning" as const,
          secretEnv: "TEST_HOOK_SECRET",
        },
        {
          id: "pager",
          urlEnv: "TEST_HOOK2_URL",
          minSeverity: "critical" as const,
          secretEnv: null,
        },
      ],
    },
  };
  env.repos.settings.set("alerts.dedupeSeconds", dedupeSeconds);
  env.repos.settings.set("alerts.emailTo", ["ops@example.org"]);
  const bus = new EventBus();
  const events: BusMessage[] = [];
  bus.subscribe((m) => events.push(m));
  const mailer = new Mailer(config);
  const posts: { url: string; body: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    posts.push({ url, body: String(init.body), headers: init.headers as Record<string, string> });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const svc = new AlertService(env.repos, config, bus, mailer, null, fetchImpl);
  return { svc, events, mailer, posts };
}

async function waitFor(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
}

describe("alerts (M12.1)", () => {
  it("delivers a test alert to in-app, email, webhook and syslog channels", async () => {
    const { svc, events, mailer, posts } = setup();
    const row = await svc.raise({
      type: "encoder_failure",
      severity: "critical",
      message: "Encoder hq.mp3 keeps failing",
      details: { mount: "hq.mp3" },
    });
    expect(row).toBeTruthy();
    // in-app: stored + pushed on the bus
    expect(env.repos.alerts.list({}).items.some((a) => a.id === row!.id)).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({ channel: "alerts", type: "alerts:new" }),
    );
    // email
    expect(mailer.outbox.at(-1)).toMatchObject({
      to: ["ops@example.org"],
      subject: expect.stringContaining("[CRITICAL]"),
    });
    // webhooks: both match a critical alert; the signed one carries an HMAC
    expect(posts.map((p) => p.url).sort()).toEqual([
      "https://hooks.example.test/alert",
      "https://hooks.example.test/critical-only",
    ]);
    const signed = posts.find((p) => p.url.endsWith("/alert"))!;
    expect(signed.headers["x-radio-signature"]).toBe(
      `sha256=${createHmac("sha256", "s3cret").update(signed.body).digest("hex")}`,
    );
    expect(JSON.parse(signed.body)).toMatchObject({
      type: "encoder_failure",
      severity: "critical",
      content: expect.stringContaining("CRITICAL"),
      text: expect.stringContaining("Encoder hq.mp3"),
    });
    expect(svc.webhookLog.every((l) => l.status === 200)).toBe(true);
    // syslog (RFC 5424 over UDP): facility local0 (16) + severity critical (2) = 130
    await waitFor(() => syslog.length > 0);
    expect(syslog.at(-1)).toMatch(/^<130>1 .* radio-player - - - Encoder hq\.mp3 keeps failing$/);
  });

  it("respects per-channel minimum severities", async () => {
    const { svc, mailer, posts } = setup();
    const before = mailer.outbox.length;
    await svc.raise({ type: "listener_drop", severity: "warning", message: "Listeners dropped" });
    expect(posts.map((p) => p.url)).toEqual(["https://hooks.example.test/alert"]); // pager is critical-only
    expect(mailer.outbox.length).toBe(before); // email is error and above
  });

  it("throttles duplicates of the same type unless the severity escalates", async () => {
    const { svc, posts } = setup(300);
    expect(
      await svc.raise({ type: "icecast_down", severity: "warning", message: "a" }),
    ).toBeTruthy();
    expect(await svc.raise({ type: "icecast_down", severity: "warning", message: "b" })).toBeNull();
    expect(await svc.raise({ type: "icecast_down", severity: "info", message: "c" })).toBeNull();
    expect(
      await svc.raise({ type: "icecast_down", severity: "critical", message: "d" }),
    ).toBeTruthy();
    expect(posts.filter((p) => JSON.parse(p.body).type === "icecast_down")).toHaveLength(3); // warning→1 hook, critical→2
    // resolve clears the throttle and the active alert
    svc.resolve("icecast_down");
    expect(
      await svc.raise({ type: "icecast_down", severity: "warning", message: "e" }),
    ).toBeTruthy();
  });

  it("lets duplicates through again after the dedupe window", async () => {
    const { svc } = setup(0);
    expect(await svc.raise({ type: "silence", severity: "error", message: "1" })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 5));
    expect(await svc.raise({ type: "silence", severity: "error", message: "2" })).toBeTruthy();
  });
});
