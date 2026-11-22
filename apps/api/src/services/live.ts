/**
 * Live sessions (PLAN §5.3 / M8): session rows, one-time studio tokens,
 * recordings (FLAC, 30-day retention), DJ shift reports and no-show alerts.
 */
import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomToken, type LiveSessionRow, type Repositories } from "@radio/db";
import { stationNow } from "@radio/core";
import type { LiveStatus, RuntimeConfig } from "@radio/shared";
import type { AlertService } from "./alerts.js";
import type { GeneratorService } from "./generator.js";
import type { WorkerClient } from "../worker-client.js";

export class LiveService {
  private noShowAlerted = new Set<string>();

  constructor(
    private readonly repos: Repositories,
    private readonly config: RuntimeConfig,
    private readonly worker: WorkerClient,
    private readonly alerts: AlertService,
    private readonly generator: GeneratorService,
  ) {}

  async start(input: {
    userId: number;
    mode: "duck" | "takeover";
    source: "studio" | "icecast" | "linein";
    record: boolean;
    input?: string | null;
    notes?: string;
  }): Promise<{ session: LiveSessionRow; token: string | null; wsPath: string }> {
    const open = this.repos.live.open();
    if (open)
      throw Object.assign(new Error(`${open.username ?? "someone"} is already live`), {
        statusCode: 409,
        code: "live_active",
      });
    const now = new Date();
    const dir = join(
      this.config.recordingsDir,
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, "0"),
    );
    const session = this.repos.live.start({
      userId: input.userId,
      mode: input.mode,
      notes: input.notes ?? null,
    });
    const recordPath = input.record
      ? join(dir, `live-${session.id}-${now.toISOString().replace(/[:.]/g, "")}.flac`)
      : null;
    if (recordPath) {
      mkdirSync(dir, { recursive: true });
      this.repos.db
        .prepare("UPDATE live_sessions SET recorded_path = ? WHERE id = ?")
        .run(recordPath, session.id);
    }
    const token = input.source === "studio" ? randomToken(24) : null;
    try {
      await this.worker.send("live:start", {
        mode: input.mode,
        source: input.source,
        userId: input.userId,
        sessionId: session.id,
        record: input.record,
        recordPath,
        token,
        input: input.input ?? null,
      });
    } catch (e) {
      this.repos.live.end(session.id, {});
      throw e;
    }
    return {
      session: this.repos.live.get(session.id)!,
      token,
      wsPath: `/ws/live?token=${token ?? ""}`,
    };
  }

  async stop(): Promise<LiveSessionRow | null> {
    const open = this.repos.live.open();
    const result = await this.worker.send<LiveStatus & { recordedPath: string | null }>(
      "live:stop",
    );
    if (!open) return null;
    const recorded =
      result.recordedPath && existsSync(result.recordedPath)
        ? statSync(result.recordedPath).size
        : null;
    if (!recorded) this.repos.live.clearRecording(open.id);
    const peak = this.repos.listeners.peak(open.started_at);
    return this.repos.live.end(open.id, { recordedSize: recorded, peakListeners: peak }) ?? null;
  }

  deleteRecording(id: number): boolean {
    const s = this.repos.live.get(id);
    if (!s?.recorded_path) return false;
    if (existsSync(s.recorded_path)) unlinkSync(s.recorded_path);
    this.repos.live.clearRecording(id);
    return true;
  }

  /** Deletes recordings older than the retention window (default 30 days). */
  purgeRecordings(now = Date.now()): number {
    const days = this.repos.settings.get(
      "retention.recordingsDays",
      this.config.retention.recordingsDays,
    );
    const expired = this.repos.live.expiredRecordings(
      new Date(now - days * 86_400_000).toISOString(),
    );
    for (const s of expired) {
      try {
        if (s.recorded_path && existsSync(s.recorded_path)) unlinkSync(s.recorded_path);
      } catch {
        // keep going
      }
      this.repos.live.clearRecording(s.id);
    }
    return expired.length;
  }

  /** No-show: a live hour started, grace passed, nobody is live → alert (worker keeps playing fallback music). */
  checkNoShow(nowMs = Date.now()): boolean {
    const clock = stationNow(this.generator.tz, nowMs);
    const override = this.generator.overrideFor(clock.date, clock.hour);
    if (!override.live) return false;
    const grace = this.repos.settings.get(
      "live.noShowGraceSeconds",
      this.config.scheduler.live.noShowGraceSeconds,
    );
    if (clock.minute * 60 + clock.second < grace) return false;
    if (this.repos.live.open()) return false;
    const key = `${clock.date}:${clock.hour}`;
    if (this.noShowAlerted.has(key)) return false;
    this.noShowAlerted.add(key);
    void this.alerts.raise({
      type: "live_no_show",
      severity: "error",
      message: `Live hour ${clock.hour}:00 started but no DJ connected after ${grace} s; fallback music is playing`,
      details: { date: clock.date, hour: clock.hour },
    });
    return true;
  }
}
