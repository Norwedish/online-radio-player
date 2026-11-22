import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MediaRow } from "@radio/db";
import type { QueueItem } from "@radio/shared";
import type { PlanSource } from "./scheduler/plan-source.js";

export function tone(dir: string, name: string, seconds: number, freq = 440, amp = 0.3): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.wav`);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `aevalsrc=${amp}*sin(2*PI*${freq}*t)|${amp}*sin(2*PI*${freq}*t):s=48000:d=${seconds}`,
    "-c:a",
    "pcm_s16le",
    path,
  ]);
  return path;
}

export function item(path: string, duration: number, extra: Partial<QueueItem> = {}): QueueItem {
  return {
    uid: randomUUID(),
    kind: "music",
    mediaId: Math.floor(Math.random() * 1e6),
    path,
    title: extra.title ?? path.split("/").pop()!,
    artist: "Test",
    duration,
    cueIn: 0,
    cueOut: null,
    fadeIn: 0,
    fadeOut: 0,
    gainDb: 0,
    planId: 1,
    planItemId: null,
    plannedStart: null,
    locked: false,
    source: "automation",
    requestId: null,
    artworkUrl: null,
    ...extra,
  };
}

/** In-memory plan source: one "hour" of items, everything else empty. */
export class FakePlanSource implements PlanSource {
  hours = new Map<string, QueueItem[]>();
  fillers: QueueItem[] = [];
  emergency: QueueItem[] = [];
  settings: Record<string, unknown> = {};
  constructor(private readonly tz = "UTC") {}
  timezone(): string {
    return this.tz;
  }
  hourItems(date: string, hour: number) {
    const items = this.hours.get(`${date}:${hour}`);
    return items ? { planId: 1, items: items.map((i) => ({ ...i })) } : null;
  }
  filler(maxSeconds: number) {
    const f = this.fillers.find((x) => x.duration <= maxSeconds);
    return f ? { ...f, uid: randomUUID() } : null;
  }
  fallbackMusic(count: number) {
    return this.fillers.slice(0, count).map((f) => ({ ...f, uid: randomUUID() }));
  }
  emergencyItems() {
    return this.emergency;
  }
  media(): MediaRow | undefined {
    return undefined;
  }
  setting<T>(key: string, fallback: T): T {
    return (this.settings[key] as T) ?? fallback;
  }
  close(): void {}
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
