/**
 * radio-playout entry point (systemd: radio-playout.service).
 * Fails fast on invalid config; exits non-zero on fatal errors so systemd
 * restarts it with backoff (PLAN §4.3).
 */
import { loadRuntimeConfig, PROJECT_VERSION } from "@radio/shared";
import { PlayoutWorker } from "./worker.js";

const log = (m: string) => console.log(`${new Date().toISOString()} [playout] ${m}`);

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  log(
    `radio-playout ${PROJECT_VERSION} starting (config ${config.configFile}, db ${config.db.file}, stereotool ${config.stereotool.enabled ? (config.stereotoolMock ? "mock" : "enabled") : "disabled"})`,
  );
  const worker = new PlayoutWorker(config, { log });
  await worker.start();
  const shutdown = async (signal: string) => {
    log(`received ${signal}, shutting down`);
    await worker.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error(
    `radio-playout fatal: ${error instanceof Error ? (error.stack ?? error.message) : error}`,
  );
  process.exit(1);
});
