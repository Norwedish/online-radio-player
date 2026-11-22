/**
 * Audio clock (PLAN §6.4.1): a sample counter derived from the monotonic
 * `process.hrtime.bigint()`, never the wall clock. Renders 10 ms blocks
 * (480 frames) as they fall due; if the event loop stalls it catches up
 * (bounded) so the output rate stays exactly 48 kHz on average.
 */
import { SAMPLE_RATE } from "@radio/core";

export const BLOCK_FRAMES = 480;
const MAX_CATCHUP_BLOCKS = 50; // 500 ms

export class AudioClock {
  private timer: NodeJS.Timeout | null = null;
  private startNs = 0n;
  private produced = 0;
  stalls = 0;

  constructor(private readonly onBlock: (frames: number) => void) {}

  get sampleClock(): number {
    return this.produced;
  }

  start(): void {
    if (this.timer) return;
    this.startNs = process.hrtime.bigint();
    this.produced = 0;
    this.timer = setInterval(() => this.tick(), 5);
  }

  tick(): void {
    const elapsedNs = process.hrtime.bigint() - this.startNs;
    const due = Number((elapsedNs * BigInt(SAMPLE_RATE)) / 1_000_000_000n);
    let blocks = Math.floor((due - this.produced) / BLOCK_FRAMES);
    if (blocks > MAX_CATCHUP_BLOCKS) {
      // Event loop was blocked for too long: skip ahead instead of bursting.
      this.stalls += 1;
      this.produced = due - MAX_CATCHUP_BLOCKS * BLOCK_FRAMES;
      blocks = MAX_CATCHUP_BLOCKS;
    }
    for (let i = 0; i < blocks; i += 1) {
      this.onBlock(BLOCK_FRAMES);
      this.produced += BLOCK_FRAMES;
    }
  }

  /** Test helper: render `seconds` of audio synchronously. */
  advance(seconds: number): void {
    const blocks = Math.round((seconds * SAMPLE_RATE) / BLOCK_FRAMES);
    for (let i = 0; i < blocks; i += 1) {
      this.onBlock(BLOCK_FRAMES);
      this.produced += BLOCK_FRAMES;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
