/**
 * Runtime configuration loader shared by radio-api, radio-playout and the CLIs.
 *
 * Order: `RADIO_CONFIG` (or `config/station.json`, falling back to
 * `config/station.example.json` in development) → schema validation → env
 * overrides for paths that differ between the Debian target and a dev box
 * (DATABASE_URL, MEDIA_ROOT, DATA_DIR, ...). Secrets are always read from the
 * environment (optionally loaded from `/etc/radio/secrets.env` or `.env`).
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseStationConfig, type StationConfig } from "./config.js";

export interface RuntimeConfig extends StationConfig {
  /** Absolute directory everything relative is resolved against. */
  rootDir: string;
  configFile: string;
  /** Writable data directory (dev default `<root>/data`, prod `/srv/radio`). */
  dataDir: string;
  recordingsDir: string;
  hlsDir: string;
  uploadsDir: string;
  /** Worker protocol endpoint (unix socket path or TCP port). */
  workerSocket: string | null;
  apiPort: number;
  apiHost: string;
  nodeEnv: string;
  /** Use the mock passthrough instead of Stereo Tool (dev/staging). */
  stereotoolMock: boolean;
}

/** Minimal dotenv parser: KEY=value lines, # comments, optional quotes. Never overrides set vars. */
export function loadEnvFile(file: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!existsSync(file)) return false;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
  return true;
}

export function findRepoRoot(start = process.cwd()): string {
  let dir = resolve(start);
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(start);
}

export function parseDatabaseUrl(value: string): string {
  if (value.startsWith("file:")) return value.slice("file:".length);
  if (value.startsWith("sqlite://")) return value.slice("sqlite://".length);
  return value;
}

export function loadRuntimeConfig(
  options: { rootDir?: string; env?: NodeJS.ProcessEnv } = {},
): RuntimeConfig {
  const env = options.env ?? process.env;
  const rootDir = options.rootDir ?? env.RADIO_ROOT ?? findRepoRoot();
  loadEnvFile(env.RADIO_SECRETS ?? "/etc/radio/secrets.env", env);
  loadEnvFile(join(rootDir, ".env"), env);

  const candidates = [
    env.RADIO_CONFIG,
    join(rootDir, "config/station.json"),
    "/etc/radio/station.json",
    join(rootDir, "config/station.example.json"),
  ].filter((c): c is string => Boolean(c));
  const configFile = candidates.find((c) => existsSync(c));
  if (!configFile) throw new Error(`No station config found (tried ${candidates.join(", ")})`);
  const parsed = parseStationConfig(JSON.parse(readFileSync(configFile, "utf8")));
  if (!parsed.ok)
    throw new Error(`Invalid station config ${configFile}:\n  ${parsed.errors.join("\n  ")}`);
  const config = parsed.config;

  const nodeEnv = env.NODE_ENV ?? "development";
  const isDev = nodeEnv !== "production" && configFile.endsWith("station.example.json");
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(rootDir, p));
  const dataDir = abs(env.DATA_DIR ?? (isDev ? join(rootDir, "data") : "/srv/radio"));

  if (env.DATABASE_URL) config.db.file = abs(parseDatabaseUrl(env.DATABASE_URL));
  else if (isDev) config.db.file = join(dataDir, "radio.db");
  if (env.MEDIA_ROOT) config.media.root = abs(env.MEDIA_ROOT);
  else if (isDev) config.media.root = join(dataDir, "media");
  if (env.MEDIA_WATCH) config.media.watchFolder = abs(env.MEDIA_WATCH);
  else if (isDev) config.media.watchFolder = join(config.media.root, "Inbox");
  if (env.ARTWORK_DIR) config.media.artworkDir = abs(env.ARTWORK_DIR);
  else if (isDev) config.media.artworkDir = join(dataDir, "artwork");
  if (env.BACKUP_DIR) {
    config.backups.dir = abs(env.BACKUP_DIR);
    config.db.backupDir = config.backups.dir;
  } else if (isDev) {
    config.backups.dir = join(dataDir, "backups");
    config.db.backupDir = config.backups.dir;
  }
  if (env.EMERGENCY_FILE) config.audio.emergencyFile = abs(env.EMERGENCY_FILE);
  else if (isDev)
    config.audio.emergencyFile = join(config.media.root, "Emergency/emergency-loop.mp3");
  if (isDev) config.media.nasPaths = [];
  if (env.ICECAST_HOST) config.icecast.host = env.ICECAST_HOST;
  if (env.ICECAST_PORT) config.icecast.port = Number(env.ICECAST_PORT);
  if (env.STEREOTOOL_BINARY) config.stereotool.binary = env.STEREOTOOL_BINARY;
  if (env.STEREOTOOL_PRESET) config.stereotool.preset = env.STEREOTOOL_PRESET;
  if (env.STEREOTOOL_LICENSE) config.stereotool.license = env.STEREOTOOL_LICENSE;
  if (env.STEREOTOOL_ENABLED !== undefined)
    config.stereotool.enabled =
      env.STEREOTOOL_ENABLED !== "0" && env.STEREOTOOL_ENABLED !== "false";
  if (env.HLS_ENABLED !== undefined)
    config.icecast.hls.enabled = env.HLS_ENABLED === "1" || env.HLS_ENABLED === "true";
  if (env.STATION_NAME) config.station.name = env.STATION_NAME;

  const stereotoolMock =
    env.STEREOTOOL_MOCK === "1" ||
    (env.STEREOTOOL_MOCK !== "0" &&
      config.stereotool.enabled &&
      !existsSync(config.stereotool.binary));

  return {
    ...config,
    rootDir,
    configFile,
    dataDir,
    recordingsDir: abs(env.RECORDINGS_DIR ?? join(dataDir, "recordings")),
    hlsDir: abs(env.HLS_DIR ?? join(dataDir, "hls")),
    uploadsDir: abs(env.UPLOADS_DIR ?? join(config.media.root, "Inbox")),
    workerSocket:
      env.PLAYOUT_SOCKET ??
      (process.platform === "win32" ? null : isDev ? null : "/run/radio/playout.sock"),
    apiPort: Number(env.PORT ?? 3001),
    apiHost: env.HOST ?? "127.0.0.1",
    nodeEnv,
    stereotoolMock,
  };
}

/** Reads a secret by env-var name (never logged). */
export function secret(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[name];
  return value && value.length > 0 ? value : undefined;
}
