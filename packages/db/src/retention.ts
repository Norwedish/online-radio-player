/** Retention jobs (PLAN M12.5): history 90 d, requests 30 d, listener stats, sessions. */
import type Database from "better-sqlite3";

export interface RetentionPolicy {
  historyDays: number;
  requestsDays: number;
  logsDays: number;
  /** Listener samples are kept as long as history. */
  listenerDays?: number;
}

export interface RetentionReport {
  playHistory: number;
  listenerStats: number;
  requests: number;
  rateLimits: number;
  sessions: number;
  passwordResets: number;
  boundaryEvents: number;
  generatorRuns: number;
}

function daysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

export function runRetention(
  db: Database.Database,
  policy: RetentionPolicy,
  now = new Date(),
): RetentionReport {
  const history = daysAgo(now, policy.historyDays);
  const requests = daysAgo(now, policy.requestsDays);
  const logs = daysAgo(now, policy.logsDays);
  const listeners = daysAgo(now, policy.listenerDays ?? policy.historyDays);
  const nowIso = now.toISOString();
  const tx = db.transaction(() => ({
    playHistory: db.prepare("DELETE FROM play_history WHERE started_at < ?").run(history).changes,
    listenerStats: db.prepare("DELETE FROM listener_stats WHERE ts < ?").run(listeners).changes,
    requests: db
      .prepare("DELETE FROM requests WHERE created_at < ? AND status != 'pending'")
      .run(requests).changes,
    rateLimits: db
      .prepare("DELETE FROM request_rate_limits WHERE window_start < ?")
      .run(daysAgo(now, 2)).changes,
    sessions: db
      .prepare(
        "DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)",
      )
      .run(nowIso, logs).changes,
    passwordResets: db.prepare("DELETE FROM password_resets WHERE expires_at < ?").run(logs)
      .changes,
    boundaryEvents: db.prepare("DELETE FROM boundary_events WHERE occurred_at < ?").run(history)
      .changes,
    generatorRuns: db.prepare("DELETE FROM generator_runs WHERE started_at < ?").run(history)
      .changes,
  }));
  return tx();
}
