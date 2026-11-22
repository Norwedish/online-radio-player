import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseStationConfig } from "./config.js";

const examplePath = fileURLToPath(new URL("../../../config/station.example.json", import.meta.url));
const example = JSON.parse(readFileSync(examplePath, "utf8"));

describe("station config schema (M1.1)", () => {
  it("accepts the shipped example config", () => {
    const result = parseStationConfig(example);
    expect(result.ok).toBe(true);
  });

  it("applies documented defaults to a minimal config", () => {
    const minimal = {
      configVersion: 1,
      station: { name: "Spike FM" },
      audio: {
        channels: 2,
        emergencyFile: "/srv/radio/media/Emergency/loop.mp3",
      },
      stereotool: {
        binary: "/opt/stereotool/stereotool_cmd",
        preset: "/etc/radio/stereotool.sds",
        license: "/opt/stereotool/stereotool.lic",
      },
      icecast: {
        sourcePasswordEnv: "ICECAST_SOURCE_PASSWORD",
        adminPasswordEnv: "ICECAST_ADMIN_PASSWORD",
        livePasswordEnv: "ICECAST_LIVE_PASSWORD",
        mounts: [
          {
            name: "hq.mp3",
            codec: "mp3",
            bitrate: "320k",
            contentType: "audio/mpeg",
            primary: true,
          },
        ],
      },
      media: {
        root: "/srv/radio/media",
        watchFolder: "/srv/radio/media/in",
        artworkDir: "/srv/radio/artwork",
      },
      scheduler: {
        generator: { generateHour00At: "23:00", generateRestAt: "00:05" },
      },
      requests: {},
    };
    const result = parseStationConfig(minimal);
    if (!result.ok) {
      throw new Error(result.errors.join("\n"));
    }
    expect(result.config.audio.boundaryToleranceSeconds).toBe(45);
    expect(result.config.station.timezone).toBe("Europe/Amsterdam");
    expect(result.config.icecast.hls.enabled).toBe(false);
    expect(result.config.scheduler.news.lockedMinutes).toEqual([0, 30]);
    expect(result.config.db.backupDir).toBe(result.config.backups.dir);
  });

  it("rejects secrets written as values instead of env names", () => {
    const bad = {
      configVersion: 1,
      station: { name: "Spike FM" },
      audio: { channels: 2, emergencyFile: "/srv/radio/media/Emergency/loop.mp3" },
      stereotool: {
        binary: "/opt/stereotool/stereotool_cmd",
        preset: "/etc/radio/stereotool.sds",
        license: "/opt/stereotool/stereotool.lic",
      },
      icecast: {
        sourcePasswordEnv: "hunter2",
        adminPasswordEnv: "ICECAST_ADMIN_PASSWORD",
        livePasswordEnv: "ICECAST_LIVE_PASSWORD",
        mounts: [
          {
            name: "hq.mp3",
            codec: "mp3",
            bitrate: "320k",
            contentType: "audio/mpeg",
            primary: true,
          },
        ],
      },
      media: {
        root: "/srv/radio/media",
        watchFolder: "/srv/radio/media/in",
        artworkDir: "/srv/radio/artwork",
      },
      scheduler: { generator: { generateHour00At: "23:00", generateRestAt: "00:05" } },
      requests: {},
    };
    const result = parseStationConfig(bad);
    expect(result.ok).toBe(false);
    if (result.ok === true) return;
    expect(result.errors.some((message) => message.includes("sourcePasswordEnv"))).toBe(true);
  });

  it("flags codec/contentType mismatches (ADR 0001)", () => {
    const bad = {
      configVersion: 1,
      station: { name: "Spike FM" },
      audio: { channels: 2, emergencyFile: "/srv/radio/media/Emergency/loop.mp3" },
      stereotool: {
        binary: "/opt/stereotool/stereotool_cmd",
        preset: "/etc/radio/stereotool.sds",
        license: "/opt/stereotool/stereotool.lic",
      },
      icecast: {
        sourcePasswordEnv: "ICECAST_SOURCE_PASSWORD",
        adminPasswordEnv: "ICECAST_ADMIN_PASSWORD",
        livePasswordEnv: "ICECAST_LIVE_PASSWORD",
        mounts: [
          {
            name: "hq.mp3",
            codec: "mp3",
            bitrate: "320k",
            contentType: "audio/ogg",
            primary: true,
          },
        ],
      },
      media: {
        root: "/srv/radio/media",
        watchFolder: "/srv/radio/media/in",
        artworkDir: "/srv/radio/artwork",
      },
      scheduler: { generator: { generateHour00At: "23:00", generateRestAt: "00:05" } },
      requests: {},
    };
    const result = parseStationConfig(bad);
    expect(result.ok).toBe(false);
    if (result.ok === true) return;
    expect(
      result.errors.some((message) => message.includes("must use contentType audio/mpeg")),
    ).toBe(true);
  });

  it("requires exactly one primary mount", () => {
    const bad = {
      configVersion: 1,
      station: { name: "Spike FM" },
      audio: { channels: 2, emergencyFile: "/srv/radio/media/Emergency/loop.mp3" },
      stereotool: {
        binary: "/opt/stereotool/stereotool_cmd",
        preset: "/etc/radio/stereotool.sds",
        license: "/opt/stereotool/stereotool.lic",
      },
      icecast: {
        sourcePasswordEnv: "ICECAST_SOURCE_PASSWORD",
        adminPasswordEnv: "ICECAST_ADMIN_PASSWORD",
        livePasswordEnv: "ICECAST_LIVE_PASSWORD",
        mounts: [
          {
            name: "hq.mp3",
            codec: "mp3",
            bitrate: "320k",
            contentType: "audio/mpeg",
            primary: true,
          },
          {
            name: "mobile.mp3",
            codec: "mp3",
            bitrate: "128k",
            contentType: "audio/mpeg",
            primary: true,
          },
        ],
      },
      media: {
        root: "/srv/radio/media",
        watchFolder: "/srv/radio/media/in",
        artworkDir: "/srv/radio/artwork",
      },
      scheduler: { generator: { generateHour00At: "23:00", generateRestAt: "00:05" } },
      requests: {},
    };
    const result = parseStationConfig(bad);
    expect(result.ok).toBe(false);
    if (result.ok === true) return;
    expect(result.errors.some((message) => message.includes("exactly one icecast mount"))).toBe(
      true,
    );
  });
});
