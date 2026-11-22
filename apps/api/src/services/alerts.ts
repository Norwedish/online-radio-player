/**
 * Alerts (PLAN §5.9 / M12.1): in-app (DB + WebSocket), email, webhooks
 * (Discord/Slack/Telegram/n8n/Home Assistant compatible JSON), structured
 * stdout/journald/syslog lines. Duplicates of the same type are throttled
 * for `dedupeSeconds` unless the severity escalates.
 */
import { createHmac } from "node:crypto";
import { createSocket } from "node:dgram";
import type { AlertRow, Repositories } from "@radio/db";
import { secret, type RuntimeConfig } from "@radio/shared";
import type { EventBus } from "./bus.js";
import type { Mailer } from "./mailer.js";
import type { Metrics } from "./metrics.js";

export type Severity = AlertRow["severity"];
const RANK: Record<Severity, number> = { info: 0, warning: 1, error: 2, critical: 3 };

export interface AlertInput {
  type: string;
  severity: Severity;
  message: string;
  details?: Record<string, unknown>;
}

export class AlertService {
  private last = new Map<string, { at: number; severity: Severity }>();
  readonly webhookLog: { url: string; status: number | string; at: string }[] = [];

  constructor(
    private readonly repos: Repositories,
    private readonly config: RuntimeConfig,
    private readonly bus: EventBus,
    private readonly mailer: Mailer,
    private readonly metrics: Metrics | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private dedupeSeconds(): number {
    return this.repos.settings.get("alerts.dedupeSeconds", this.config.alerts.dedupeSeconds);
  }

  /** Returns the stored alert, or null when throttled. */
  async raise(input: AlertInput): Promise<AlertRow | null> {
    const now = Date.now();
    const prev = this.last.get(input.type);
    if (
      prev &&
      now - prev.at < this.dedupeSeconds() * 1000 &&
      RANK[input.severity] <= RANK[prev.severity]
    )
      return null;
    this.last.set(input.type, { at: now, severity: input.severity });
    const row = this.repos.alerts.create(input);
    this.metrics?.inc("radio_alerts_total", { type: input.type, severity: input.severity });
    this.bus.publish("alerts", "alerts:new", row);
    this.syslog(row);
    await Promise.allSettled([this.email(row), this.webhooks(row)]);
    return row;
  }

  resolve(type: string): void {
    if (this.repos.alerts.resolveType(type) > 0)
      this.bus.publish("alerts", "alerts:resolved", { type });
    this.last.delete(type);
  }

  private syslog(row: AlertRow): void {
    const line = JSON.stringify({
      tag: this.config.alerts.syslogTag,
      level: row.severity,
      alert: row.type,
      message: row.message,
      details: row.details,
      at: row.created_at,
    });
    console.log(line);
    const host = process.env.SYSLOG_HOST;
    if (host) {
      const pri = 8 * 16 + ({ info: 6, warning: 4, error: 3, critical: 2 } as const)[row.severity];
      const msg = Buffer.from(
        `<${pri}>1 ${row.created_at} ${this.config.station.domain} ${this.config.alerts.syslogTag} - - - ${row.message}`,
      );
      const sock = createSocket("udp4");
      sock.send(msg, Number(process.env.SYSLOG_PORT ?? 514), host, () => sock.close());
    }
  }

  private async email(row: AlertRow): Promise<void> {
    if (!this.config.alerts.email || RANK[row.severity] < RANK.error) return;
    const to = this.repos.settings.get<string[]>("alerts.emailTo", this.config.alerts.emailTo);
    await this.mailer.send(
      to,
      `[${row.severity.toUpperCase()}] ${this.config.station.name}: ${row.type}`,
      `${row.message}\n\n${JSON.stringify(row.details ?? {}, null, 2)}\n\n${row.created_at}`,
    );
  }

  private async webhooks(row: AlertRow): Promise<void> {
    for (const hook of this.config.webhooks.alerts) {
      if (RANK[row.severity] < RANK[hook.minSeverity]) continue;
      const url = secret(hook.urlEnv);
      if (!url) continue;
      const body = JSON.stringify({
        station: this.config.station.name,
        type: row.type,
        severity: row.severity,
        message: row.message,
        details: row.details,
        at: row.created_at,
        // Discord/Slack-friendly text fields.
        content: `**${row.severity.toUpperCase()}** ${row.message}`,
        text: `${row.severity.toUpperCase()}: ${row.message}`,
      });
      const headers: Record<string, string> = { "content-type": "application/json" };
      const signing = hook.secretEnv ? secret(hook.secretEnv) : undefined;
      if (signing)
        headers["x-radio-signature"] =
          `sha256=${createHmac("sha256", signing).update(body).digest("hex")}`;
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(5000),
        });
        this.webhookLog.push({ url: hook.id, status: res.status, at: new Date().toISOString() });
      } catch (e) {
        this.webhookLog.push({
          url: hook.id,
          status: (e as Error).message,
          at: new Date().toISOString(),
        });
      }
      if (this.webhookLog.length > 50) this.webhookLog.shift();
    }
  }
}
