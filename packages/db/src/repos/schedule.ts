import type Database from "better-sqlite3";
import { bool, buildSet, fromJson, nowIso, toJson } from "../util.js";
import type { HourlyPlanRow, PlanItemRow, PlanStatus, ScheduleSlotRow } from "./types.js";

type Raw = Record<string, unknown>;

function mapSlot(row: Raw): ScheduleSlotRow {
  const { days_json, ...rest } = row;
  return {
    ...(rest as unknown as ScheduleSlotRow),
    days: fromJson<number[]>(days_json as string, [1, 2, 3, 4, 5, 6, 7]),
    loop_once: bool(row.loop_once),
    enabled: bool(row.enabled),
  };
}

function mapPlan(row: Raw | undefined): HourlyPlanRow | undefined {
  if (!row) return undefined;
  const { warnings_json, snapshot_json, ...rest } = row;
  return {
    ...(rest as unknown as HourlyPlanRow),
    warnings: fromJson<string[]>(warnings_json as string, []),
    snapshot: fromJson<unknown>(snapshot_json as string, null),
  };
}

function mapItem(row: Raw): PlanItemRow {
  return { ...(row as unknown as PlanItemRow), is_locked: bool(row.is_locked) };
}

export interface PlanItemInput {
  mediaId: number | null;
  kind: PlanItemRow["kind"];
  startSeconds: number;
  length: number;
  playlistId: number | null;
  artist: string | null;
  title: string | null;
  locked: boolean;
}

export class ScheduleRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly stationId: number,
  ) {}

  /* ── Slots ───────────────────────────────────────────────────────────── */

  slots(): ScheduleSlotRow[] {
    return this.db
      .prepare(
        `SELECT s.*, p.name AS playlist_name FROM schedule_slots s JOIN playlists p ON p.id = s.playlist_id
         WHERE s.station_id = ? ORDER BY s.hour, s.priority DESC, s.start_date DESC`,
      )
      .all(this.stationId)
      .map((r) => mapSlot(r as Raw));
  }

  /** The effective slot for `hour` on `date` (YYYY-MM-DD, ISO weekday 1-7). */
  slotFor(date: string, hour: number, isoWeekday: number): ScheduleSlotRow | undefined {
    return this.slots().find(
      (s) =>
        s.hour === hour &&
        s.enabled &&
        s.start_date <= date &&
        (s.end_date === null || s.end_date >= date) &&
        s.days.includes(isoWeekday),
    );
  }

  createSlot(input: {
    hour: number;
    playlistId: number;
    startDate: string;
    days?: number[];
    endDate?: string | null;
    priority?: number;
  }): ScheduleSlotRow {
    const now = nowIso();
    const hh = String(input.hour).padStart(2, "0");
    const next = String((input.hour + 1) % 24).padStart(2, "0");
    this.db
      .prepare(
        `INSERT INTO schedule_slots (station_id, hour, playlist_id, start_time, end_time, days_json, start_date, end_date, loop_once, priority, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ?)`,
      )
      .run(
        this.stationId,
        input.hour,
        input.playlistId,
        `${hh}:00`,
        `${next}:00`,
        toJson(input.days ?? [1, 2, 3, 4, 5, 6, 7]),
        input.startDate,
        input.endDate ?? null,
        input.priority ?? 0,
        now,
        now,
      );
    return this.slots().find((s) => s.hour === input.hour && s.start_date === input.startDate)!;
  }

  updateSlot(
    id: number,
    patch: Partial<{
      playlist_id: number;
      enabled: boolean;
      priority: number;
      end_date: string | null;
      days: number[];
    }>,
  ): void {
    const p: Record<string, unknown> = { ...patch };
    if (patch.days) {
      p.days_json = toJson(patch.days);
      delete p.days;
    }
    const { sql, params } = buildSet(p, [
      "playlist_id",
      "enabled",
      "priority",
      "end_date",
      "days_json",
    ]);
    if (!sql) return;
    this.db
      .prepare(
        `UPDATE schedule_slots SET ${sql}, updated_at = @now WHERE id = @id AND station_id = @sid`,
      )
      .run({ ...params, now: nowIso(), id, sid: this.stationId });
  }

  /* ── Plans ───────────────────────────────────────────────────────────── */

  plan(date: string, hour: number): HourlyPlanRow | undefined {
    return mapPlan(
      this.db
        .prepare("SELECT * FROM hourly_plans WHERE station_id = ? AND plan_date = ? AND hour = ?")
        .get(this.stationId, date, hour) as Raw,
    );
  }

  planById(id: number): HourlyPlanRow | undefined {
    return mapPlan(this.db.prepare("SELECT * FROM hourly_plans WHERE id = ?").get(id) as Raw);
  }

  plansForDate(date: string): HourlyPlanRow[] {
    return this.db
      .prepare("SELECT * FROM hourly_plans WHERE station_id = ? AND plan_date = ? ORDER BY hour")
      .all(this.stationId, date)
      .map((r) => mapPlan(r as Raw)!);
  }

  items(planId: number): PlanItemRow[] {
    return this.db
      .prepare("SELECT * FROM plan_items WHERE plan_id = ? ORDER BY position")
      .all(planId)
      .map((r) => mapItem(r as Raw));
  }

  /** Writes (or replaces) one hour plan atomically (M3.4). */
  savePlan(input: {
    date: string;
    hour: number;
    status: PlanStatus;
    totalSeconds: number;
    warnings: string[];
    snapshot: unknown;
    items: PlanItemInput[];
  }): HourlyPlanRow {
    const tx = this.db.transaction(() => {
      const existing = this.plan(input.date, input.hour);
      let planId: number;
      const now = nowIso();
      if (existing) {
        planId = existing.id;
        this.db.prepare("DELETE FROM plan_items WHERE plan_id = ?").run(planId);
        this.db
          .prepare(
            "UPDATE hourly_plans SET status = ?, generated_at = ?, total_seconds = ?, warnings_json = ?, snapshot_json = ? WHERE id = ?",
          )
          .run(
            input.status,
            now,
            input.totalSeconds,
            toJson(input.warnings),
            toJson(input.snapshot),
            planId,
          );
      } else {
        const info = this.db
          .prepare(
            `INSERT INTO hourly_plans (station_id, plan_date, hour, status, generated_at, total_seconds, warnings_json, snapshot_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            this.stationId,
            input.date,
            input.hour,
            input.status,
            now,
            input.totalSeconds,
            toJson(input.warnings),
            toJson(input.snapshot),
          );
        planId = Number(info.lastInsertRowid);
      }
      const ins = this.db.prepare(
        `INSERT INTO plan_items (plan_id, position, media_id, kind, start_seconds, length, playlist_id, artist, title, is_locked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      input.items.forEach((item, position) =>
        ins.run(
          planId,
          position,
          item.mediaId,
          item.kind,
          item.startSeconds,
          item.length,
          item.playlistId,
          item.artist,
          item.title,
          item.locked ? 1 : 0,
        ),
      );
      return planId;
    });
    return this.planById(tx())!;
  }

  setPlanStatus(id: number, status: PlanStatus): void {
    this.db.prepare("UPDATE hourly_plans SET status = ? WHERE id = ?").run(status, id);
  }

  deletePlan(date: string, hour: number): boolean {
    const plan = this.plan(date, hour);
    if (!plan) return false;
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM plan_items WHERE plan_id = ?").run(plan.id);
      this.db.prepare("DELETE FROM boundary_events WHERE plan_id = ?").run(plan.id);
      this.db.prepare("UPDATE play_history SET plan_id = NULL WHERE plan_id = ?").run(plan.id);
      this.db.prepare("DELETE FROM hourly_plans WHERE id = ?").run(plan.id);
    });
    tx();
    return true;
  }

  /** Recently planned media (for separation seeding): plan items with absolute start times. */
  plannedSince(
    fromDate: string,
  ): {
    media_id: number;
    artist: string | null;
    plan_date: string;
    hour: number;
    start_seconds: number;
  }[] {
    return this.db
      .prepare(
        `SELECT i.media_id, i.artist, p.plan_date, p.hour, i.start_seconds FROM plan_items i
         JOIN hourly_plans p ON p.id = i.plan_id
         WHERE p.station_id = ? AND p.plan_date >= ? AND i.kind = 'music' AND i.media_id IS NOT NULL`,
      )
      .all(this.stationId, fromDate) as {
      media_id: number;
      artist: string | null;
      plan_date: string;
      hour: number;
      start_seconds: number;
    }[];
  }

  /* ── Boundary events ─────────────────────────────────────────────────── */

  logBoundary(input: {
    planId: number;
    occurredAt: string;
    boundaryAt: string;
    action: "cut" | "let_finish" | "early_news" | "late_news" | "none";
    deviationMs: number;
    details: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO boundary_events (station_id, plan_id, occurred_at, boundary_at, action, deviation_ms, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.stationId,
        input.planId,
        input.occurredAt,
        input.boundaryAt,
        input.action,
        Math.round(input.deviationMs),
        toJson(input.details),
      );
  }

  boundaryEvents(
    sinceIso: string,
    limit = 200,
  ): {
    id: number;
    plan_id: number;
    occurred_at: string;
    boundary_at: string;
    action: string;
    deviation_ms: number;
    details: unknown;
  }[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM boundary_events WHERE station_id = ? AND occurred_at >= ? ORDER BY occurred_at DESC LIMIT ?",
        )
        .all(this.stationId, sinceIso, limit) as Raw[]
    ).map((r) => {
      const { details_json, ...rest } = r;
      return {
        ...(rest as Record<string, never>),
        details: fromJson(details_json as string, {}),
      } as never;
    });
  }

  /* ── schedule_settings ───────────────────────────────────────────────── */

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db
      .prepare("SELECT value_json FROM schedule_settings WHERE station_id = ? AND key = ?")
      .get(this.stationId, key) as Raw | undefined;
    return fromJson<T>(row?.value_json as string | undefined, fallback);
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO schedule_settings (station_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(station_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(this.stationId, key, toJson(value), nowIso());
  }

  /* ── generator_runs ──────────────────────────────────────────────────── */

  startRun(runType: string, mode: string, hours: unknown): number {
    const info = this.db
      .prepare(
        "INSERT INTO generator_runs (station_id, run_type, started_at, mode, hours_json, status) VALUES (?, ?, ?, ?, ?, 'running')",
      )
      .run(this.stationId, runType, nowIso(), mode, toJson(hours));
    return Number(info.lastInsertRowid);
  }

  finishRun(
    id: number,
    status: "ok" | "warning" | "failed" | "skipped",
    warnings: string[],
    error?: string,
  ): void {
    this.db
      .prepare(
        "UPDATE generator_runs SET finished_at = ?, status = ?, warnings_json = ?, error = ? WHERE id = ?",
      )
      .run(nowIso(), status, toJson(warnings), error ?? null, id);
  }

  runs(
    limit = 50,
  ): {
    id: number;
    run_type: string;
    started_at: string;
    finished_at: string | null;
    mode: string | null;
    hours: unknown;
    status: string;
    warnings: string[];
    error: string | null;
  }[] {
    return (
      this.db
        .prepare("SELECT * FROM generator_runs WHERE station_id = ? ORDER BY id DESC LIMIT ?")
        .all(this.stationId, limit) as Raw[]
    ).map((r) => {
      const { hours_json, warnings_json, ...rest } = r;
      return {
        ...(rest as Record<string, never>),
        hours: fromJson(hours_json as string, []),
        warnings: fromJson(warnings_json as string, []),
      } as never;
    });
  }

  lastRun(runType: string): { started_at: string; status: string } | undefined {
    return this.db
      .prepare(
        "SELECT started_at, status FROM generator_runs WHERE station_id = ? AND run_type = ? ORDER BY id DESC LIMIT 1",
      )
      .get(this.stationId, runType) as { started_at: string; status: string } | undefined;
  }
}
