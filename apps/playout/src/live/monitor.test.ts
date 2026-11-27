import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { LiveBus } from "../audio/live-bus.js";
import { Mixer } from "../audio/mixer.js";
import { LiveServer } from "./live-server.js";
import { halfRate } from "./monitor.js";

const servers: LiveServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function startServer(): Promise<{ server: LiveServer; port: number }> {
  const server = new LiveServer(new LiveBus(20), () => {});
  servers.push(server);
  await server.listen(0); // the OS picks a free port
  return { server, port: server.port };
}

function connect(
  port: number,
  token: string,
): Promise<{ ws: WebSocket; msgs: (Buffer | string)[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/live/monitor?token=${token}`);
    const msgs: (Buffer | string)[] = [];
    ws.on("message", (d, binary) => msgs.push(binary ? (d as Buffer) : String(d)));
    ws.on("open", () => resolve({ ws, msgs }));
    ws.on("error", reject);
    ws.on("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

const until = async (fn: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

/** Stereo s16 block where every sample equals `v`. */
const block = (v: number, frames = 480) => {
  const b = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames * 2; i += 1) b.writeInt16LE(v, i * 2);
  return b;
};

describe("studio monitor", () => {
  it("streams the program to a listener with a one-time token, and rejects reuse", async () => {
    const { server, port } = await startServer();
    server.monitor.allow("token-aaaaaaaaaaaaaaaa", { mic: true, rate: 48000 });
    const { ws, msgs } = await connect(port, "token-aaaaaaaaaaaaaaaa");
    await until(() => msgs.length > 0);
    expect(JSON.parse(msgs[0] as string)).toMatchObject({
      type: "hello",
      rate: 48000,
      channels: 2,
    });
    server.monitor.feed(block(1000), block(5));
    await until(() => msgs.length > 1);
    const pcm = msgs[1] as Buffer;
    expect(pcm.length).toBe(480 * 4);
    expect(pcm.readInt16LE(0)).toBe(1000); // with mic → the program itself
    ws.close();
    // The token was consumed.
    await expect(connect(port, "token-aaaaaaaaaaaaaaaa")).rejects.toThrow(/401/);
    await expect(connect(port, "nope")).rejects.toThrow(/401/);
  });

  it("without mic sends the dry mix; light mode halves the rate; several listeners", async () => {
    const { server, port } = await startServer();
    server.monitor.allow("token-dry-0000000000001", { mic: false, rate: 48000 });
    server.monitor.allow("token-lite-000000000001", { mic: false, rate: 24000 });
    const a = await connect(port, "token-dry-0000000000001");
    const b = await connect(port, "token-lite-000000000001");
    await until(() => server.monitor.listeners === 2);
    expect(server.monitor.wantsDry).toBe(true);
    server.monitor.feed(block(1000), block(7));
    await until(() => a.msgs.length > 1 && b.msgs.length > 1);
    expect((a.msgs[1] as Buffer).readInt16LE(0)).toBe(7);
    expect((b.msgs[1] as Buffer).length).toBe(240 * 4);
    a.ws.close();
    b.ws.close();
    await until(() => server.monitor.listeners === 0);
    expect(server.monitor.wantsDry).toBe(false);
  });

  it("halfRate averages sample pairs per channel", () => {
    const src = Buffer.alloc(16);
    [100, -100, 300, -300].forEach((v, i) => src.writeInt16LE(v, i * 2)); // frame 0: L100 R-100, frame 1: L300 R-300
    [10, 20, 30, 40].forEach((v, i) => src.writeInt16LE(v, 8 + i * 2));
    const out = halfRate(src);
    expect(out.length).toBe(8);
    expect([0, 1, 2, 3].map((i) => out.readInt16LE(i * 2))).toEqual([200, -200, 20, 30]);
  });

  it("the mixer's dry output leaves out the live mic", () => {
    const live = new LiveBus(0);
    const mixer = new Mixer(live, { duckDb: 0, duckAttackMs: 1, duckReleaseMs: 1 });
    live.active = true;
    // Feed the mic a loud tone (mono → both channels).
    const mic = Buffer.alloc(4800 * 2);
    for (let i = 0; i < 4800; i += 1) mic.writeInt16LE(i % 2 ? 16000 : -16000, i * 2);
    live.push(mic, 1);
    mixer.wantDry = true;
    let programPeak = 0;
    let dryPeak = 0;
    for (let k = 0; k < 5; k += 1) {
      const out = mixer.render(480);
      for (let i = 0; i < out.length; i += 2)
        programPeak = Math.max(programPeak, Math.abs(out.readInt16LE(i)));
      const dry = mixer.lastDry!;
      for (let i = 0; i < dry.length; i += 2)
        dryPeak = Math.max(dryPeak, Math.abs(dry.readInt16LE(i)));
    }
    expect(programPeak).toBeGreaterThan(5000);
    expect(dryPeak).toBe(0);
    mixer.wantDry = false;
    mixer.render(480);
    expect(mixer.lastDry).toBeNull();
  });
});
