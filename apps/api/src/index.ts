/**
 * radio-api entry point (systemd: radio-api.service). Restarting the API never
 * interrupts audio: the playout worker keeps running (PLAN §4.3).
 */
import { existsSync, mkdirSync } from "node:fs";
import { loadRuntimeConfig, PROJECT_VERSION } from "@radio/shared";
import { createContext } from "./context.js";
import { startJobs } from "./jobs.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const ctx = await createContext(config);
  ctx.log(
    `radio-api ${PROJECT_VERSION} starting (config ${config.configFile}, db ${config.db.file})`,
  );
  for (const dir of [
    config.media.root,
    config.media.watchFolder,
    config.media.artworkDir,
    config.recordingsDir,
    config.backups.dir,
  ]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const app = await buildServer(ctx);
  ctx.worker.start();
  ctx.sync.start();
  ctx.watcher.start();
  const stopJobs = startJobs(ctx, { backups: process.env.BACKUP_TIMER === "api" });
  await app.listen({ port: config.apiPort, host: config.apiHost });
  ctx.log(`radio-api listening on http://${config.apiHost}:${config.apiPort}`);
  const shutdown = async (signal: string) => {
    ctx.log(`received ${signal}, shutting down`);
    stopJobs();
    await app.close().catch(() => {});
    await ctx.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error(
    `radio-api fatal: ${error instanceof Error ? (error.stack ?? error.message) : error}`,
  );
  process.exit(1);
});
