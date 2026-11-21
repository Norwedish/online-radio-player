import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Json = Record<string, unknown>;

const path = resolve(process.argv[2] ?? "config/station.example.json");

function fail(message: string): never {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function get(obj: unknown, keyPath: string): unknown {
  return keyPath.split(".").reduce<unknown>((value, key) => {
    if (value && typeof value === "object" && key in value) {
      return (value as Json)[key];
    }
    return undefined;
  }, obj);
}

let config: unknown;
try {
  config = JSON.parse(readFileSync(path, "utf8"));
} catch (error) {
  fail(`Cannot read/parse ${path}: ${(error as Error).message}`);
}

const required: Array<[string, string]> = [
  ["station.name", "string"],
  ["station.timezone", "string"],
  ["audio.sampleRate", "number"],
  ["audio.channels", "number"],
  ["audio.boundaryToleranceSeconds", "number"],
  ["audio.emergencyFile", "string"],
  ["stereotool.binary", "string"],
  ["stereotool.preset", "string"],
  ["icecast.host", "string"],
  ["icecast.port", "number"],
  ["scheduler.generator.generateHour00At", "string"],
  ["scheduler.generator.generateRestAt", "string"],
  ["scheduler.generator.separationTrackHours", "number"],
  ["scheduler.generator.separationArtistHours", "number"],
];

for (const [key, type] of required) {
  const value = get(config, key);
  if (value === undefined || value === null || value === "") {
    fail(`Missing required config value: ${key}`);
  }
  if (typeof value !== type) {
    fail(`Config value ${key} must be ${type}, got ${typeof value}`);
  }
}

const mounts = get(config, "icecast.mounts");
if (!Array.isArray(mounts) || mounts.length === 0) {
  fail("icecast.mounts must be a non-empty array");
}

for (const [index, mount] of mounts.entries()) {
  if (!mount || typeof mount !== "object") {
    fail(`icecast.mounts[${index}] must be an object`);
  }
  for (const key of ["name", "codec", "bitrate"]) {
    if (!(key in (mount as Json))) {
      fail(`icecast.mounts[${index}] is missing ${key}`);
    }
  }
}

const sampleRate = get(config, "audio.sampleRate");
if (sampleRate !== 48000 && sampleRate !== 44100) {
  fail("audio.sampleRate must be 48000 or 44100");
}

const tolerance = get(config, "audio.boundaryToleranceSeconds") as number;
if (tolerance < 0 || tolerance > 300) {
  fail("audio.boundaryToleranceSeconds must be between 0 and 300");
}

console.log(`✅ Config OK: ${path}`);
console.log(`   station: ${String(get(config, "station.name"))}`);
console.log(`   timezone: ${String(get(config, "station.timezone"))}`);
console.log(`   mounts: ${mounts.map((m) => String((m as Json).name)).join(", ")}`);
