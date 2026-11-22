import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStationConfig, type WorkerAlert } from "@radio/shared";
import { describe, expect, it } from "vitest";
import { sleep } from "../test-utils.js";
import {
  createStereoTool,
  expandArgs,
  ProcessStereoTool,
  type StereoToolConfig,
} from "./adapter.js";

const MOCK = join(import.meta.dirname, "../../../../scripts/mock-stereotool.mjs");

function stConfig(over: Partial<StereoToolConfig> = {}): StereoToolConfig {
  const base = parseStationConfig(
    JSON.parse(
      readFileSync(join(import.meta.dirname, "../../../../config/station.example.json"), "utf8"),
    ),
  );
  if (!base.ok) throw new Error("example config invalid");
  return { ...base.config.stereotool, ...over, restart: { maxAttempts: 2, backoffMs: 200 } };
}

function harness() {
  const alerts: WorkerAlert[] = [];
  const out: Buffer[] = [];
  return {
    alerts,
    out,
    bytes: () => out.reduce((n, b) => n + b.length, 0),
    opts: {
      mock: false,
      mockScript: MOCK,
      log: () => {},
      alert: (a: WorkerAlert) => alerts.push(a),
    },
  };
}

const block = (fill: number) => Buffer.alloc(3840, fill); // 20 ms of s16le stereo

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
}

describe("Stereo Tool adapter (M5.1 / M5.6)", () => {
  it("expands argument placeholders", () => {
    expect(
      expandArgs(["-", "-", "-s", "{preset}", "-k", "{licenseKey}", "{rate}/{channels}"], {
        preset: "/p.sds",
        license: "/l.lic",
        licenseKey: "KEY",
        rate: "48000",
        channels: "2",
      }),
    ).toEqual(["-", "-", "-s", "/p.sds", "-k", "KEY", "48000/2"]);
  });

  it("is a passthrough when disabled", async () => {
    const h = harness();
    const st = createStereoTool(stConfig({ enabled: false }), h.opts);
    st.onOutput((c) => h.out.push(c));
    await st.start();
    st.writePcm(block(7));
    expect(h.bytes()).toBe(3840);
    expect(st.status()).toMatchObject({ enabled: false, bypassed: true, mode: "bypass" });
  });

  it("round-trips PCM through the mock process with the WAV header stripped", async () => {
    const h = harness();
    const st = createStereoTool(stConfig(), { ...h.opts, mock: true });
    st.onOutput((c) => h.out.push(c));
    await st.start();
    for (let i = 0; i < 10; i += 1) st.writePcm(block(i + 1));
    await until(() => h.bytes() >= 38_400);
    await st.stop();
    const all = Buffer.concat(h.out);
    expect(all.length).toBe(38_400);
    expect(all[0]).toBe(1); // no RIFF header leaked into the PCM
    expect(all[all.length - 1]).toBe(10);
    expect(st.status()).toMatchObject({ enabled: true, mode: "mock", edition: "mock" });
  });

  it("bypasses, alerts and restarts when the process dies, then gives up after maxAttempts", async () => {
    const h = harness();
    // A "binary" that dies at once: node -e process.exit(3)
    const st = new ProcessStereoTool(stConfig(), h.opts, "stdio-pcm", process.execPath, [
      "-e",
      "process.exit(3)",
    ]);
    st.onOutput((c) => h.out.push(c));
    await st.start();
    await until(() => !st.running);
    st.writePcm(block(5));
    expect(h.bytes()).toBe(3840); // bypassed audio keeps the station on air
    expect(st.status().bypassed).toBe(true);
    await until(() => st.exhausted, 8000);
    expect(st.restarts).toBe(2);
    expect(h.alerts.map((a) => a.type)).toEqual(["stereotool_bypass", "stereotool_failed"]);
    expect(h.alerts.every((a) => a.severity === "critical")).toBe(true);
    await st.stop();
  }, 15_000);

  it("holds output silent instead of bypassing when bypassOnFailure is off", async () => {
    const h = harness();
    const st = new ProcessStereoTool(
      stConfig({ bypassOnFailure: false }),
      h.opts,
      "stdio-pcm",
      process.execPath,
      ["-e", "process.exit(1)"],
    );
    st.onOutput((c) => h.out.push(c));
    await st.start();
    await until(() => !st.running);
    st.writePcm(block(5));
    expect(h.bytes()).toBe(0);
    expect(h.alerts[0]).toMatchObject({ type: "stereotool_bypass", severity: "error" });
    await st.stop();
  });

  it("raises stereotool_missing when the binary is absent", async () => {
    const h = harness();
    const st = createStereoTool(stConfig({ binary: "/nonexistent/stereotool_cmd" }), h.opts);
    await st.start();
    expect(h.alerts[0]).toMatchObject({ type: "stereotool_missing", severity: "critical" });
    expect(st.status()).toMatchObject({ running: false, bypassed: true, mode: "stdio-pcm" });
    await st.stop();
  });

  it("kills and restarts a process that stops producing output", async () => {
    const h = harness();
    const st = new ProcessStereoTool(
      stConfig(),
      { ...h.opts, stallMs: 300 },
      "stdio-pcm",
      process.execPath,
      ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"],
    );
    st.onOutput((c) => h.out.push(c));
    await st.start();
    await sleep(400);
    st.writePcm(block(1));
    await until(() => st.restarts >= 1, 3000);
    expect(st.restarts).toBeGreaterThanOrEqual(1);
    expect(h.alerts[0]?.type).toBe("stereotool_bypass");
    await st.stop();
  });
});
