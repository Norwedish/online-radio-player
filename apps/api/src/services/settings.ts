/**
 * Settings service (PLAN M1.5): typed getters/setters over the `settings`
 * table, every change audited with old/new values, and playout-relevant keys
 * hot-reloaded in the worker via `settings:reload`.
 */
import { z } from "zod";
import type { Repositories } from "@radio/db";
import type { WorkerClient } from "../worker-client.js";

export const SETTING_DEFINITIONS = {
  "audio.masterGain": {
    schema: z.number().gt(0).lte(1.5),
    category: "audio",
    worker: true,
    label: "Master gain",
  },
  "audio.boundaryToleranceSeconds": {
    schema: z.number().int().gte(0).lte(300),
    category: "audio",
    worker: true,
    label: "Hour boundary tolerance (s)",
  },
  "audio.silenceThresholdDb": {
    schema: z.number().gte(-90).lte(-20),
    category: "audio",
    worker: true,
    label: "Silence threshold (dBFS)",
  },
  "audio.silenceSeconds": {
    schema: z.number().int().gte(2).lte(120),
    category: "audio",
    worker: true,
    label: "Silence before emergency (s)",
  },
  "audio.targetLufs": {
    schema: z.number().gte(-30).lte(-8),
    category: "audio",
    worker: false,
    label: "Loudness target (LUFS)",
  },
  "live.duckDb": {
    schema: z.number().gte(-40).lte(0),
    category: "live",
    worker: true,
    label: "Ducking depth (dB)",
  },
  "live.duckAttackMs": {
    schema: z.number().int().gte(5).lte(2000),
    category: "live",
    worker: true,
    label: "Duck attack (ms)",
  },
  "live.duckReleaseMs": {
    schema: z.number().int().gte(50).lte(5000),
    category: "live",
    worker: true,
    label: "Duck release (ms)",
  },
  "live.noShowGraceSeconds": {
    schema: z.number().int().gte(0).lte(900),
    category: "live",
    worker: false,
    label: "Live no-show grace (s)",
  },
  "requests.enabled": {
    schema: z.boolean(),
    category: "requests",
    worker: false,
    label: "Requests enabled",
  },
  "requests.autoApprove": {
    schema: z.boolean(),
    category: "requests",
    worker: false,
    label: "Auto-approve requests",
  },
  "requests.cooldownMinutes": {
    schema: z.number().int().gte(0).lte(1440),
    category: "requests",
    worker: false,
    label: "Per-IP cooldown (min)",
  },
  "requests.maxPerHour": {
    schema: z.number().int().gte(0).lte(100),
    category: "requests",
    worker: false,
    label: "Max requests per hour per IP",
  },
  "requests.profanityFilter": {
    schema: z.boolean(),
    category: "requests",
    worker: false,
    label: "Profanity filter",
  },
  "requests.dedications": {
    schema: z.boolean(),
    category: "requests",
    worker: false,
    label: "Allow dedications",
  },
  "retention.historyDays": {
    schema: z.number().int().gte(1).lte(3650),
    category: "retention",
    worker: false,
    label: "History (days)",
  },
  "retention.logsDays": {
    schema: z.number().int().gte(1).lte(365),
    category: "retention",
    worker: false,
    label: "Logs/sessions (days)",
  },
  "retention.requestsDays": {
    schema: z.number().int().gte(1).lte(365),
    category: "retention",
    worker: false,
    label: "Requests (days)",
  },
  "retention.recordingsDays": {
    schema: z.number().int().gte(1).lte(365),
    category: "retention",
    worker: false,
    label: "Recordings (days)",
  },
  "backups.dailyKeep": {
    schema: z.number().int().gte(1).lte(365),
    category: "backups",
    worker: false,
    label: "Daily backups kept",
  },
  "backups.weeklyKeep": {
    schema: z.number().int().gte(1).lte(120),
    category: "backups",
    worker: false,
    label: "Weekly backups kept",
  },
  "alerts.emailTo": {
    schema: z.array(z.string().email()).max(20),
    category: "alerts",
    worker: false,
    label: "Alert email recipients",
  },
  "alerts.dedupeSeconds": {
    schema: z.number().int().gte(0).lte(3600),
    category: "alerts",
    worker: false,
    label: "Alert dedupe window (s)",
  },
} as const;

export type SettingKey = keyof typeof SETTING_DEFINITIONS;

export class SettingsService {
  constructor(
    private readonly repos: Repositories,
    private readonly worker: WorkerClient | null,
  ) {}

  get<T>(key: SettingKey, fallback: T): T {
    return this.repos.settings.get(key, fallback);
  }

  /** All typed settings grouped by category, with labels for the UI. */
  list(
    category?: string,
  ): { key: string; value: unknown; category: string; label: string; reloadsWorker: boolean }[] {
    return (
      Object.entries(SETTING_DEFINITIONS) as [
        SettingKey,
        (typeof SETTING_DEFINITIONS)[SettingKey],
      ][]
    )
      .filter(([, d]) => !category || d.category === category)
      .map(([key, d]) => ({
        key,
        value: this.repos.settings.get(key, null),
        category: d.category,
        label: d.label,
        reloadsWorker: d.worker,
      }));
  }

  /**
   * Validates and applies a patch atomically; writes one audit entry per changed
   * key; asks the worker to reload when a playout key changed.
   */
  async update(
    patch: Record<string, unknown>,
    actor: { userId: number | null; ip: string | null },
  ): Promise<{ changed: string[]; workerReloaded: boolean }> {
    const errors: string[] = [];
    const parsed: [SettingKey, unknown][] = [];
    for (const [key, value] of Object.entries(patch)) {
      const def = SETTING_DEFINITIONS[key as SettingKey];
      if (!def) {
        errors.push(`${key}: unknown setting`);
        continue;
      }
      const r = def.schema.safeParse(value);
      if (!r.success) errors.push(`${key}: ${r.error.issues[0]?.message ?? "invalid"}`);
      else parsed.push([key as SettingKey, r.data]);
    }
    if (errors.length)
      throw Object.assign(new Error("invalid settings"), {
        statusCode: 400,
        code: "validation_error",
        details: errors,
      });
    const changed: string[] = [];
    this.repos.db.transaction(() => {
      for (const [key, value] of parsed) {
        const old = this.repos.settings.get<unknown>(key, null);
        if (JSON.stringify(old) === JSON.stringify(value)) continue;
        this.repos.settings.set(key, value);
        this.repos.audit.write({
          userId: actor.userId,
          action: "settings.update",
          entityType: "setting",
          metadata: { key, old, new: value },
          ip: actor.ip,
        });
        changed.push(key);
      }
    })();
    let workerReloaded = false;
    if (
      changed.some((k) => SETTING_DEFINITIONS[k as SettingKey].worker) &&
      this.worker?.connected
    ) {
      try {
        await this.worker.send("settings:reload");
        workerReloaded = true;
      } catch {
        workerReloaded = false;
      }
    }
    return { changed, workerReloaded };
  }
}
