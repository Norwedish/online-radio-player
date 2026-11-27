import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStationConfig, type WorkerAlert } from "@radio/shared";
import { describe, expect, it } from "vitest";
import { sleep } from "../test-utils.js";
import {
  createStereoTool,
  expandArgs,
  ProcessStereoTool,
  readLicenseKey,
  type StereoToolConfig,
} from "./adapter.js";

describe("licence key source", () => {
  it("prefers the key file (installer/console) over the env var", () => {
    const dir = mkdtempSync(join(tmpdir(), "st-key-"));
    const file = join(dir, "license.key");
    process.env.TEST_ST_ENV_KEY = "env-key";
    try {
      expect(readLicenseKey("TEST_ST_ENV_KEY", file)).toBe("env-key");
      writeFileSync(file, "  file-key\n");
      expect(readLicenseKey("TEST_ST_ENV_KEY", file)).toBe("file-key");
      writeFileSync(file, "\n");
      expect(readLicenseKey("TEST_ST_ENV_KEY", file)).toBe("env-key");
      expect(readLicenseKey("TEST_ST_NOPE", undefined)).toBe("");
    } finally {
      delete process.env.TEST_ST_ENV_KEY;
    }
  });
});

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
    const st = createStereoTool(
      stConfig({ inputMode: "stdio-pcm", binary: "/nonexistent/stereotool_cmd" }),
      h.opts,
    );
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

/** Builds the fake libStereoTool with the system C compiler, or null when there is none. */
function buildFakeLibrary(): string | null {
  const dir = mkdtempSync(join(tmpdir(), "fake-st-"));
  const out = join(dir, process.platform === "win32" ? "fake.dll" : "libfake.so");
  for (const cc of ["cc", "gcc", "clang"]) {
    try {
      execFileSync(
        cc,
        [
          "-shared",
          "-fPIC",
          "-O2",
          "-o",
          out,
          join(import.meta.dirname, "fixtures/fake-libstereotool.c"),
        ],
        { stdio: "ignore" },
      );
      return out;
    } catch {
      // try the next compiler
    }
  }
  return null;
}

const FAKE_LIB = buildFakeLibrary();

describe("Stereo Tool plugin mode (libStereoTool via koffi)", () => {
  it("raises stereotool_missing when the library is absent", async () => {
    const h = harness();
    const st = createStereoTool(
      stConfig({ inputMode: "plugin", library: "/nonexistent/libStereoTool_intel64.so" }),
      h.opts,
    );
    await st.start();
    expect(h.alerts[0]).toMatchObject({ type: "stereotool_missing", severity: "critical" });
    expect(h.alerts[0]!.message).toMatch(/plugin library not found/);
    expect(st.status()).toMatchObject({ mode: "plugin", running: false, bypassed: true });
    await st.stop();
  });

  describe.skipIf(!FAKE_LIB)("with a compiled fake library", () => {
    const presets = mkdtempSync(join(tmpdir(), "st-presets-"));
    const preset = join(presets, "station.sts");
    const crash = join(presets, "crash.sts");
    writeFileSync(preset, "[Stereo Tool]\n");
    writeFileSync(crash, "[Stereo Tool]\n");

    it("processes PCM through the library, reports version/latency and a valid licence", async () => {
      process.env.TEST_ST_KEY = "good-key";
      const h = harness();
      const logs: string[] = [];
      const st = createStereoTool(
        stConfig({ inputMode: "plugin", library: FAKE_LIB!, preset, licenseKeyEnv: "TEST_ST_KEY" }),
        { ...h.opts, log: (m) => logs.push(m), homeDir: join(presets, "home") },
      ) as ProcessStereoTool;
      st.onOutput((c) => h.out.push(c));
      await st.start();
      // Until the host reports ready, audio is bypassed (no startup delay on air).
      expect(st.status().bypassed).toBe(true);
      st.writePcm(Buffer.alloc(3840, 0));
      expect(h.bytes()).toBe(3840);
      h.out.length = 0;
      await until(() => st.info !== null);
      expect(st.status().bypassed).toBe(false);
      const pcm = Buffer.alloc(3840);
      for (let i = 0; i < 1920; i += 1) pcm.writeInt16LE(10_000, i * 2);
      for (let i = 0; i < 10; i += 1) st.writePcm(pcm);
      await until(() => h.bytes() >= 38_400);
      const out = Buffer.concat(h.out);
      expect(out.length).toBe(38_400); // raw PCM both ways: no WAV header in plugin mode
      expect(out.readInt16LE(0)).toBe(5000); // the fake halves every sample
      await until(() => st.info !== null);
      expect(st.info).toMatchObject({
        softwareVersion: 11080,
        apiVersion: 256,
        latencyMs: 10,
        loadType: 10387,
        valid: true,
      });
      expect(st.status()).toMatchObject({
        mode: "plugin",
        running: true,
        edition: "v11.08 licensed",
      });
      expect(logs.some((l) => /plugin v11\.08 ready .*preset load type 10387/.test(l))).toBe(true);
      expect(logs.join("\n")).not.toContain("good-key");
      expect(h.alerts).toEqual([]);
      await st.stop();
      delete process.env.TEST_ST_KEY;
    }, 15_000);

    it("alerts when the licence does not cover the preset", async () => {
      const h = harness();
      const st = createStereoTool(
        stConfig({
          inputMode: "plugin",
          library: FAKE_LIB!,
          preset,
          licenseKeyEnv: "TEST_ST_NO_KEY",
        }),
        h.opts,
      ) as ProcessStereoTool;
      await st.start();
      st.writePcm(Buffer.alloc(3840));
      await until(() => h.alerts.length > 0);
      expect(h.alerts[0]).toMatchObject({ type: "stereotool_unlicensed", severity: "error" });
      expect(h.alerts[0]!.message).toContain("Advanced clipper");
      expect(st.status().edition).toBe("v11.08 unlicensed");
      await st.stop();
    }, 15_000);

    it("isolates a crash inside the library: bypass, alert, restart", async () => {
      const h = harness();
      const st = createStereoTool(
        stConfig({ inputMode: "plugin", library: FAKE_LIB!, preset: crash }),
        h.opts,
      ) as ProcessStereoTool;
      st.onOutput((c) => h.out.push(c));
      await st.start();
      await until(() => st.info !== null);
      st.writePcm(Buffer.alloc(3840, 1)); // Process() aborts the host
      await until(() => !st.running);
      st.writePcm(Buffer.alloc(3840, 2));
      expect(h.bytes()).toBe(3840); // bypassed audio kept flowing in the worker
      expect(h.alerts.find((a) => a.type === "stereotool_bypass")).toMatchObject({
        severity: "critical",
      });
      await until(() => st.restarts >= 1, 3000);
      expect(st.restarts).toBeGreaterThanOrEqual(1);
      await st.stop();
    }, 15_000);
  });
});
