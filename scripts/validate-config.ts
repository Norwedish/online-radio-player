/**
 * `pnpm config:validate [path]` — validate a station config JSON against the
 * Zod schema in `packages/shared/src/config.ts` (PLAN M1.1).
 *
 * Usage:
 *   pnpm config:validate                          # config/station.example.json
 *   pnpm config:validate /etc/radio/station.json  # any real config
 *
 * Exit codes: 0 = config is valid; 1 = unreadable JSON or validation errors.
 * Each problem is printed as `path.to.key: message (rule)` so operators can
 * fix one line at a time.
 *
 * Note on imports: the root workspace has no runtime alias for `@radio/shared`,
 * so the schema is imported from its source file — `tsx` transpiles it on the
 * fly, and `zod` resolves through `packages/shared/node_modules`.
 */
import { parseStationConfig, STATION_CONFIG_VERSION } from "../packages/shared/src/config.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Secret env-var names referenced by the config (keys ending in `Env`). */
function collectEnvNames(node: unknown): string[] {
  if (typeof node !== "object" || node === null) {
    return [];
  }
  const found: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key.endsWith("Env") && typeof value === "string") {
      found.push(value);
    } else if (value !== null && typeof value === "object") {
      found.push(...collectEnvNames(value));
    }
  }
  return found;
}

const path = resolve(process.argv[2] ?? "config/station.example.json");

function fail(message: string): never {
  console.error(`\u274C ${message}`);
  process.exit(1);
}

let config: unknown;
try {
  config = JSON.parse(readFileSync(path, "utf8"));
} catch (error) {
  fail(`Cannot read/parse ${path}: ${(error as Error).message}`);
}

const result = parseStationConfig(config);
if (!result.ok) {
  console.error(
    `\u274C ${path} is not a valid station config (${result.errors.length} problem(s)): `,
  );
  for (const line of result.errors) {
    console.error(`   - ${line}`);
  }
  process.exit(1);
}

const station = result.config;
if (station.configVersion !== STATION_CONFIG_VERSION) {
  console.log(
    `\u26A0 configVersion ${station.configVersion} != expected ${STATION_CONFIG_VERSION}`,
  );
}

const mounts = station.icecast.mounts.map((mount) => {
  const flags = [mount.primary ? "primary" : undefined, mount.public ? undefined : "private"];
  const suffix = flags.filter(Boolean).length > 0 ? ` (${flags.filter(Boolean).join(", ")})` : "";
  return `${mount.name} ${mount.bitrate} ${mount.contentType}${suffix}`;
});
const st = station.stereotool;
const hls = station.icecast.hls;

console.log(`\u2705 Config OK: ${path}`);
console.log(
  `   station : ${station.station.name} (id ${station.station.id}, ${station.station.timezone}, ${station.station.domain})`,
);
console.log(`   mounts  : ${mounts.join(", ")}`);
console.log(
  `   hls     : ${hls.enabled ? `on at ${hls.mount} (${hls.segmentSeconds}s segments)` : "off (ADR 0003: optional output)"}`,
);
console.log(
  `   stereo  : ${st.enabled ? `on (${st.binary}, bypass on failure: ${st.bypassOnFailure ? "yes" : "no"})` : "off (bypassed)"}`,
);
console.log(
  `   audio   : ${station.audio.sampleRate} Hz / ${station.audio.channels} ch / ${station.audio.format}, boundary tolerance ${station.audio.boundaryToleranceSeconds}s`,
);
console.log(
  `   files   : db ${station.db.file}, backups ${station.db.backupDir}, media ${station.media.root}`,
);

const envNames = [...new Set(collectEnvNames(config))].sort();
if (envNames.length > 0) {
  console.log(`   secrets : ${envNames.join(", ")} (env-var names only, never values in the JSON)`);
  const missing = envNames.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.log(
      `\u26A0 ${missing.length} secret env var(s) not set in this shell (${missing.join(", ")}) — resolved at deploy time from /etc/radio/secrets.env`,
    );
  }
}
