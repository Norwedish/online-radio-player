import { DEFAULT_BOUNDARY_TOLERANCE_SECONDS } from "@radio/core";
import { PROJECT_VERSION } from "@radio/shared";
import { startSkeletonStream } from "./skeleton.js";

/**
 * M0 scaffold: a long-running worker with a heartbeat plus the M0.10 walking
 * skeleton stream (tone -> mock ST -> Icecast). M4 replaces both with the audio
 * clock, decks, mixer and scheduler.
 */
const heartbeatMs = Number(process.env.PLAYOUT_HEARTBEAT_MS ?? 10_000);

console.log(
  `radio-playout ${PROJECT_VERSION} started (boundary tolerance ${DEFAULT_BOUNDARY_TOLERANCE_SECONDS}s)`,
);

const skeleton = process.env.PLAYOUT_SKELETON_STREAM === "0" ? null : startSkeletonStream();
if (skeleton) {
  console.log("radio-playout skeleton stream is live on /hq.mp3");
}

const timer = setInterval(() => {
  console.log(`radio-playout heartbeat ${new Date().toISOString()}`);
}, heartbeatMs);

function shutdown(signal: string): void {
  console.log(`radio-playout received ${signal}, shutting down`);
  clearInterval(timer);
  skeleton?.stop();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
