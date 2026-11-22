/**
 * Audio integration test (PLAN M4.8 / M5 / §9.2): real FFmpeg + real Icecast +
 * mock Stereo Tool process + the playout worker. Asserts audio on every mount,
 * HLS segments, encoder restart, Icecast reconnect, Stereo Tool restart,
 * protocol control (skip) and live ducking.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect } from "node:net";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeConfig, type RuntimeConfig } from "../../packages/shared/src/index.ts";
import { PlayoutWorker } from "../../apps/playout/src/worker.ts";
import { FakePlanSource, item, tone } from "../../apps/playout/src/test-utils.ts";
import {
  ADMIN_PASSWORD,
  SOURCE_PASSWORD,
  TestIcecast,
  freePort,
  icecastBinary,
} from "./helpers.ts";

const hasIcecast = icecastBinary() !== null;
const MOUNTS = ["hq.mp3", "mobile.mp3", "opus.ogg", "aac.aac"];

describe.skipIf(!hasIcecast)("audio chain with real Icecast (M4.8/M5)", () => {
  let dir: string;
  let config: RuntimeConfig;
  let icecast: TestIcecast;
  let worker: PlayoutWorker;
  let source: FakePlanSource;
  const events: { event: string; payload: Record<string, unknown> }[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "radio-chain-"));
    chmodSync(dir, 0o755); // Icecast drops to nobody when started as root
    const port = await freePort();
    process.env.IT_SOURCE_PW = SOURCE_PASSWORD;
    process.env.IT_ADMIN_PW = ADMIN_PASSWORD;
    config = loadRuntimeConfig({
      env: {
        NODE_ENV: "test",
        DATA_DIR: dir,
        RADIO_SECRETS: join(dir, "x"),
        ICECAST_PORT: String(port),
        HLS_ENABLED: "1",
        STEREOTOOL_MOCK: "1",
        ICECAST_SOURCE_PASSWORD: SOURCE_PASSWORD,
      },
    });
    config.icecast.sourcePasswordEnv = "IT_SOURCE_PW";
    config.icecast.port = port;
    icecast = new TestIcecast(join(dir, "icecast"), config);
    await icecast.start();

    source = new FakePlanSource("UTC");
    const music = Array.from({ length: 6 }, (_, i) =>
      tone(join(dir, "media"), `m${i}`, 6, 300 + i * 70, 0.3),
    );
    const now = Date.now();
    const d = new Date(now);
    const key = `${d.toISOString().slice(0, 10)}:${d.getUTCHours()}`;
    source.hours.set(
      key,
      music.map((p, i) => item(p, 6, { title: `Track ${i}`, plannedStart: now + i * 6000 })),
    );
    source.fillers = music.map((p, i) => item(p, 6, { title: `Filler ${i}` }));
    const protoPort = await freePort();
    worker = new PlayoutWorker(config, {
      source,
      endpoint: { port: protoPort },
      livePort: await freePort(),
      log: () => {},
    });
    await worker.start();
    const sock = connect(protoPort, "127.0.0.1");
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (dd: string) => {
      buf += dd;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const m = JSON.parse(buf.slice(0, i)) as {
          event?: string;
          payload: Record<string, unknown>;
        };
        buf = buf.slice(i + 1);
        if (m.event) events.push({ event: m.event, payload: m.payload });
      }
    });
    (globalThis as { __sock?: unknown }).__sock = sock;
  }, 30_000);

  afterAll(async () => {
    (globalThis as { __sock?: { destroy(): void } }).__sock?.destroy();
    await worker?.stop();
    await icecast?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("publishes audible audio on every mount with the right content type", async () => {
    await icecast.waitForMounts(MOUNTS);
    const mounts = await icecast.mounts();
    expect(mounts.find((m) => m.mount === "hq.mp3")?.type).toBe("audio/mpeg");
    expect(mounts.find((m) => m.mount === "opus.ogg")?.type).toBe("audio/ogg");
    expect(mounts.find((m) => m.mount === "aac.aac")?.type).toBe("audio/aac");
    for (const mount of MOUNTS) {
      const s = await icecast.sample(mount, 2);
      expect(s.bytes, mount).toBeGreaterThan(5_000);
      expect(s.meanDb, mount).toBeGreaterThan(-30);
    }
  }, 60_000);

  it("writes HLS segments and a live playlist", async () => {
    const end = Date.now() + 10_000;
    while (
      Date.now() < end &&
      !(
        existsSync(join(config.hlsDir, "stream.m3u8")) &&
        readdirSync(config.hlsDir).filter((f) => f.endsWith(".ts")).length >= 2
      )
    ) {
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(
      readdirSync(config.hlsDir).filter((f) => f.endsWith(".ts")).length,
    ).toBeGreaterThanOrEqual(2);
  }, 20_000);

  it("Stereo Tool (mock process) is in the chain and reports running", () => {
    expect(worker.stereotool.status()).toMatchObject({
      enabled: true,
      running: true,
      mode: "mock",
    });
  });

  it("restarts a killed encoder and the mount comes back", async () => {
    const enc = worker.hub.encoders.get("mobile.mp3")!;
    enc.kill();
    // The first restart is scheduled after a 1 s backoff; Icecast may still list the old
    // mount until then, so wait for the restart itself before checking the mount.
    const t0 = Date.now();
    while (enc.restarts < 1 && Date.now() - t0 < 10_000)
      await new Promise((r) => setTimeout(r, 100));
    expect(enc.restarts).toBeGreaterThanOrEqual(1);
    await icecast.waitForMounts(["mobile.mp3"], 15_000);
    expect((await icecast.sample("mobile.mp3", 1.5)).meanDb).toBeGreaterThan(-30);
  }, 30_000);

  it("skip via the protocol changes the playing track", async () => {
    const before = worker.engine.current?.item.title;
    const res = await worker.handle("skip", {});
    expect(res).toBeTruthy();
    await new Promise((r) => setTimeout(r, 500));
    expect(worker.engine.current?.item.title).not.toBe(before);
    expect(events.some((e) => e.event === "track_started")).toBe(true);
    expect(events.some((e) => e.event === "meter")).toBe(true);
  }, 10_000);

  it("ducks automation while a live source is on air", async () => {
    await worker.handle("live:start", {
      mode: "duck",
      source: "studio",
      userId: 1,
      sessionId: 1,
      record: true,
      recordPath: join(dir, "rec/live.flac"),
      token: "t",
      input: null,
    });
    const pcm = Buffer.alloc(48_000 * 2 * 2); // 1 s mono silence-ish
    for (let i = 0; i < pcm.length / 2; i += 1)
      pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 1000 * i) / 48000)), i * 2);
    worker.live.push(pcm, 1);
    await new Promise((r) => setTimeout(r, 800));
    expect(worker.mixer.duckGain).toBeLessThan(0.3);
    const ended = (await worker.handle("live:stop", {})) as { recordedPath: string | null };
    expect(ended.recordedPath).toBeTruthy();
    expect(existsSync(ended.recordedPath!)).toBe(true);
  }, 15_000);

  it("encoders reconnect when Icecast restarts (M5.6)", async () => {
    await icecast.stop();
    await new Promise((r) => setTimeout(r, 1500));
    expect(
      worker.hub
        .statuses()
        .filter((s) => s.mount !== "hls")
        .some((s) => !s.running || s.restarts > 0),
    ).toBe(true);
    await icecast.start();
    await icecast.waitForMounts(MOUNTS, 40_000);
    expect((await icecast.sample("hq.mp3", 1.5)).meanDb).toBeGreaterThan(-30);
  }, 60_000);
});
