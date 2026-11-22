import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntimeConfig } from "./runtime.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));

describe("runtime config resolution", () => {
  it("never falls back to the system config outside production", () => {
    // On an installed box /etc/radio/station.json exists; tests must still stay in DATA_DIR.
    const dir = mkdtempSync(join(tmpdir(), "radio-rt-"));
    const cfg = loadRuntimeConfig({ rootDir: root, env: { NODE_ENV: "test", DATA_DIR: dir } });
    expect(cfg.configFile).not.toBe("/etc/radio/station.json");
    expect(cfg.db.file.startsWith(dir)).toBe(true);
    expect(cfg.media.root.startsWith(dir)).toBe(true);
  });

  it("applies env overrides on top of an explicit RADIO_CONFIG", () => {
    const cfg = loadRuntimeConfig({
      rootDir: root,
      env: {
        NODE_ENV: "production",
        RADIO_CONFIG: join(root, "config/station.example.json"),
        RADIO_SECRETS: "/nonexistent",
        DATABASE_URL: "file:/tmp/x.sqlite",
        ICECAST_PORT: "8123",
        STATION_NAME: "Override FM",
      },
    });
    expect(cfg.db.file).toBe("/tmp/x.sqlite");
    expect(cfg.icecast.port).toBe(8123);
    expect(cfg.station.name).toBe("Override FM");
    expect(cfg.dataDir).toBe("/srv/radio");
  });
});
