import { describe, expect, it, vi } from "vitest";
import {
  cString,
  licenseReport,
  loadTypeCandidates,
  openInstance,
  PcmProcessor,
  type StereoToolBinding,
} from "../../bin/stereotool-host.mjs";

function fakeBinding(over: Partial<StereoToolBinding> = {}): StereoToolBinding & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    softwareVersion: () => 11080,
    apiVersion: () => 256,
    setBindIp: (w, u) => calls.push(`bind ${w} ${u}`),
    enableInternalSoundCard: (e) => calls.push(`soundcard ${e}`),
    create: (key) => (calls.push(`create ${key}`), { h: 1 }),
    create3: (gui, key, name, home) => (
      calls.push(`create3 ${gui} ${key} ${name} ${home}`),
      { h: 3 }
    ),
    destroy: () => calls.push("destroy"),
    loadPreset: (_h, file, type) => (calls.push(`load ${file} ${type}`), type === 10387),
    latency: (_h, rate, feed) => (calls.push(`latency ${rate} ${feed}`), 4096),
    licenseValid: () => false,
    unlicensedFeatures: (_h, text) => {
      text.set(Buffer.from("Advanced clipper\0junk"));
      return false;
    },
    process: () => {},
    ...over,
  };
}

describe("Stereo Tool plugin host", () => {
  it("maps load types, newest SDK numbering first", () => {
    expect(loadTypeCandidates()).toEqual([20387, 10387]);
    expect(loadTypeCandidates("all_settings")).toEqual([20386, 10386]);
    expect(loadTypeCandidates(12345)).toEqual([12345]);
    expect(() => loadTypeCandidates("nope")).toThrow(/unknown preset load type/);
  });

  it("opens an instance like Liquidsoap: bind to loopback, Create3 without GUI, preset, latency", () => {
    const st = fakeBinding();
    const inst = openInstance(
      st,
      {
        library: "/x.so",
        preset: "/etc/radio/p.sts",
        licenseKeyEnv: "ST_KEY",
        home: "/tmp/st-home-test",
      },
      { ST_KEY: "abc" },
    );
    expect(inst).toMatchObject({ loadType: 10387, latencySamples: 4096, rate: 48_000 });
    expect(st.calls).toEqual([
      "bind 127.0.0.1 127.0.0.1",
      "soundcard false",
      "create3 false abc radio-player /tmp/st-home-test",
      "load /etc/radio/p.sts 20387", // current numbering tried first …
      "load /etc/radio/p.sts 10387", // … then the older one
      "latency 48000 true",
    ]);
  });

  it("falls back to stereoTool_Create, passes no key when unset, skips the preset when none", () => {
    const st = fakeBinding({ create3: null });
    const inst = openInstance(st, { library: "/x.so" }, {});
    expect(inst.loadType).toBeNull();
    expect(st.calls).toContain("create null");
    expect(st.calls.some((c) => c.startsWith("load"))).toBe(false);
  });

  it("fails clearly (and frees the instance) when the preset does not load", () => {
    const st = fakeBinding({ loadPreset: () => false });
    expect(() => openInstance(st, { library: "/x.so", preset: "/bad.sts" }, {})).toThrow(
      /preset could not be loaded: \/bad.sts/,
    );
    expect(st.calls).toContain("destroy");
  });

  it("reports licence state and the unlicensed-feature text", () => {
    expect(licenseReport(fakeBinding(), {})).toEqual({
      valid: false,
      unlicensedFeatures: "Advanced clipper",
    });
    expect(cString(new Uint8Array([104, 105, 0, 120]))).toBe("hi");
  });

  it("converts s16le chunks of any size into whole frames and back, with clipping", () => {
    const seen: number[] = [];
    const proc = new PcmProcessor((f, frames) => {
      seen.push(frames);
      for (let i = 0; i < f.length; i += 1) f[i] = f[i]! * 4; // +12 dB, clips
    });
    const pcm = Buffer.alloc(4 * 3);
    [1000, -1000, 16000, -16000, 0, 32767].forEach((v, i) => pcm.writeInt16LE(v, i * 2));
    // Split mid-frame: 5 bytes, then the rest.
    const a = proc.push(pcm.subarray(0, 5));
    const b = proc.push(pcm.subarray(5));
    expect(seen).toEqual([1, 2]);
    const out = Buffer.concat([a, b]);
    expect(out.length).toBe(12);
    const vals = Array.from({ length: 6 }, (_, i) => out.readInt16LE(i * 2));
    expect(vals).toEqual([4000, -4000, 32767, -32768, 0, 32767]);
    expect(proc.framesProcessed).toBe(3);
  });

  it("round-trips samples unchanged through an identity processor", () => {
    const proc = new PcmProcessor(vi.fn());
    const pcm = Buffer.alloc(960 * 4);
    for (let i = 0; i < 960 * 2; i += 1)
      pcm.writeInt16LE(Math.round(Math.sin(i / 7) * 20000), i * 2);
    expect(proc.push(pcm).equals(pcm)).toBe(true);
  });
});
