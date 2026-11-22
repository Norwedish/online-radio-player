/**
 * Station-time helpers (Luxon). Plans are keyed by station-local date + hour;
 * everything absolute is epoch ms / UTC ISO. DST: a local hour that does not
 * exist (spring forward) has no plan; a repeated local hour (fall back) shares
 * one plan.
 */
import { DateTime } from "luxon";

export interface StationClock {
  date: string;
  hour: number;
  minute: number;
  second: number;
  isoWeekday: number;
  epochMs: number;
}

export function stationNow(tz: string, nowMs = Date.now()): StationClock {
  const dt = DateTime.fromMillis(nowMs, { zone: tz });
  return {
    date: dt.toISODate()!,
    hour: dt.hour,
    minute: dt.minute,
    second: dt.second,
    isoWeekday: dt.weekday,
    epochMs: nowMs,
  };
}

/** Epoch ms of `date hour:00` in `tz`, or null when that local hour does not exist (DST gap). */
export function hourStartMs(date: string, hour: number, tz: string): number | null {
  const dt = DateTime.fromISO(`${date}T${String(hour).padStart(2, "0")}:00:00`, { zone: tz });
  if (!dt.isValid || dt.hour !== hour || dt.toISODate() !== date) return null;
  return dt.toMillis();
}

export function addDays(date: string, days: number): string {
  return DateTime.fromISO(date, { zone: "UTC" }).plus({ days }).toISODate()!;
}

export function isoWeekday(date: string): number {
  return DateTime.fromISO(date, { zone: "UTC" }).weekday;
}

/** Next local hour boundary after `nowMs` (handles DST by asking Luxon). */
export function nextHourBoundaryMs(tz: string, nowMs: number): number {
  return DateTime.fromMillis(nowMs, { zone: tz }).startOf("hour").plus({ hours: 1 }).toMillis();
}

export type GuardResult = "ok" | "on_air" | "past" | "nonexistent";

/**
 * Generator guards (PLAN 5.1 / M3.5): never rewrite the on-air hour or an hour
 * that already passed. Hour 0 of tomorrow is always allowed.
 */
export function generationGuard(
  date: string,
  hour: number,
  tz: string,
  nowMs: number,
): GuardResult {
  const start = hourStartMs(date, hour, tz);
  if (start === null) return "nonexistent";
  const end = DateTime.fromMillis(start, { zone: tz }).plus({ hours: 1 }).toMillis();
  if (nowMs >= start && nowMs < end) return "on_air";
  if (nowMs >= end) return "past";
  return "ok";
}

export function parseHHMM(value: string): { hour: number; minute: number } {
  const [h, m] = value.split(":").map(Number);
  return { hour: h ?? 0, minute: m ?? 0 };
}

/** Wall-clock minute of day in station time. */
export function minuteOfDay(clock: Pick<StationClock, "hour" | "minute">): number {
  return clock.hour * 60 + clock.minute;
}
