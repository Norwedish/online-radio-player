import { DEFAULT_BOUNDARY_TOLERANCE_SECONDS } from "@radio/core";
import { PROJECT_VERSION } from "@radio/shared";

/**
 * M0 scaffold: a long-running worker with a heartbeat.
 * M4 replaces this with the audio clock, decks, mixer and scheduler.
 */
const heartbeatMs = Number(process.env.PLAYOUT_HEARTBEAT_MS ?? 10_000);

console.log(
  `radio-playout ${PROJECT_VERSION} started (boundary tolerance ${DEFAULT_BOUNDARY_TOLERANCE_SECONDS}s)`,
);

const timer = setInterval(() => {
  console.log(`radio-playout heartbeat ${new Date().toISOString()}`);
}, heartbeatMs);

function shutdown(signal: string): void {
  console.log(`radio-playout received ${signal}, shutting down`);
  clearInterval(timer);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
