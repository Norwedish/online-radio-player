/**
 * Opt-in check against Thimeo's real generic plugin library (not in the repo —
 * proprietary). Point STEREOTOOL_LIBRARY at libStereoTool_intel64.so (and
 * optionally STEREOTOOL_PRESET at a .sts preset) to run it:
 *
 *   STEREOTOOL_LIBRARY=/opt/stereotool/libStereoTool_intel64.so pnpm test:integration
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStationConfig, type WorkerAlert } from "@radio/shared";
import { describe, expect, it } from "vitest";
import {
  createStereoTool,
  type ProcessStereoTool,
} from "../../apps/playout/src/stereotool/adapter.js";

const LIB = process.env.STEREOTOOL_LIBRARY;

describe.skipIf(!LIB)("real libStereoTool plugin", () => {
  it("processes a tone through the library and reports version, latency and licence", async () => {
    const parsed = parseStationConfig(
      JSON.parse(
        readFileSync(join(import.meta.dirname, "../../config/station.example.json"), "utf8"),
      ),
    );
    if (!parsed.ok) throw new Error("example config invalid");
    const alerts: WorkerAlert[] = [];
    const out: Buffer[] = [];
    const st = createStereoTool(
      {
        ...parsed.config.stereotool,
        inputMode: "plugin",
        library: LIB!,
        preset: process.env.STEREOTOOL_PRESET ?? "",
      },
      {
        mock: false,
        mockScript: "",
        log: (m) => console.log(m),
        alert: (a) => alerts.push(a),
        homeDir: "/tmp/radio-stereotool-it",
      },
    ) as ProcessStereoTool;
    st.onOutput((c) => out.push(c));
    await st.start();
    const ready0 = Date.now();
    while (!st.info && Date.now() - ready0 < 15_000) await new Promise((r) => setTimeout(r, 50));
    // 5 s of a −20 dBFS 997 Hz tone in 20 ms blocks, in real time-ish bursts.
    const block = Buffer.alloc(3840);
    let phase = 0;
    for (let b = 0; b < 250; b += 1) {
      for (let i = 0; i < 960; i += 1) {
        const v = Math.round(0.1 * Math.sin(phase) * 32767);
        phase += (2 * Math.PI * 997) / 48_000;
        block.writeInt16LE(v, i * 4);
        block.writeInt16LE(v, i * 4 + 2);
      }
      st.writePcm(Buffer.from(block));
      if (b % 25 === 0) await new Promise((r) => setTimeout(r, 20));
    }
    const t0 = Date.now();
    while (out.reduce((n, c) => n + c.length, 0) < 250 * 3840 && Date.now() - t0 < 10_000)
      await new Promise((r) => setTimeout(r, 50));
    const pcm = Buffer.concat(out);
    expect(pcm.length).toBe(250 * 3840);
    // Skip the processing latency (leading silence), then measure the level.
    const skip = Math.ceil(((st.info?.latencyMs ?? 100) / 1000) * 48_000 + 4800) * 4;
    let sum = 0;
    let n = 0;
    for (let i = skip; i < pcm.length; i += 2) {
      const v = pcm.readInt16LE(i) / 32768;
      sum += v * v;
      n += 1;
    }
    const rmsDb = 10 * Math.log10(sum / n);
    console.log(
      `stereotool plugin: ${JSON.stringify(st.info)}, output ${rmsDb.toFixed(1)} dBFS RMS`,
    );
    expect(st.info?.softwareVersion).toBeGreaterThan(0);
    expect(rmsDb).toBeGreaterThan(-60); // audio comes out
    expect(st.status()).toMatchObject({ mode: "plugin", running: true });
    await st.stop();
  }, 30_000);
});
