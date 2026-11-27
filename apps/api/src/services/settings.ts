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
  "audio.autocue.enabled": {
    schema: z.boolean(),
    category: "audio",
    worker: false,
    label: "Detect cue points and fades (autocue)",
    default: true,
  },
  "audio.autocue.cueInThreshold": {
    schema: z.number().gte(-80).lte(0),
    category: "audio",
    worker: false,
    label: "Cue-in threshold (dB below loudness)",
    default: -34,
  },
  "audio.autocue.cueOutThreshold": {
    schema: z.number().gte(-80).lte(0),
    category: "audio",
    worker: false,
    label: "Cue-out threshold (dB below loudness)",
    default: -42,
  },
  "audio.autocue.crossThreshold": {
    schema: z.number().gte(-40).lte(0),
    category: "audio",
    worker: false,
    label: "Crossfade trigger (dB below loudness)",
    default: -7,
  },
  "audio.autocue.maxOverlap": {
    schema: z.number().gte(0).lte(30),
    category: "audio",
    worker: true,
    label: "Maximum crossfade (s)",
    default: 6,
  },
  "audio.autocue.sustainedEndings": {
    schema: z.boolean(),
    category: "audio",
    worker: false,
    label: "Keep long sustained endings",
    default: true,
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

/** Plain-language explanation per setting (the ⓘ tooltip in Settings). Every key must have one. */
export const SETTING_HELP: Record<SettingKey, string> = {
  "audio.masterGain":
    "Overall volume of everything that goes on air, before Stereo Tool. 1 = unchanged, 0.5 ≈ −6 dB, 1.5 ≈ +3.5 dB. A safety limiter at −1 dBFS stops clipping.",
  "audio.boundaryToleranceSeconds":
    "How flexible the news on the hour (and half hour) is. A song that ends at most this many seconds after the hour may finish and the news starts a little late; one that runs longer is faded out at the hour. A song that ends shortly before the hour starts the news a little early, and no new song is started with less than this time left.",
  "audio.silenceThresholdDb":
    "Anything quieter than this counts as silence (dead air). −60 dBFS is near-silent; raise it (e.g. −50) if hiss or very quiet passages should also count.",
  "audio.silenceSeconds":
    "How long the station may be silent before the emergency loop takes over automatically. In manual (studio) mode a gap of at least 60 seconds hands the station back to automation instead.",
  "audio.targetLufs":
    "Every track is played at this loudness so songs sound equally loud (like AzuraCast's lufs_target). −16 is relaxed, −12 is louder. Changing it applies to the whole library at once; the original files are never modified.",
  "audio.autocue.enabled":
    "Measure every track and set its start, end and crossfade automatically from the volume, like AzuraCast/Liquidsoap autocue. Tracks whose cue points you set by hand are left alone.",
  "audio.autocue.cueInThreshold":
    "Where a track starts: the first moment it gets louder than this many dB below its own average loudness. Lower (e.g. −40) keeps quiet intros; higher skips more of a soft start. Liquidsoap: cue_in_threshold.",
  "audio.autocue.cueOutThreshold":
    "Where a track ends: the last moment it is louder than this many dB below its average loudness. Lower (−42) plays fades out to near silence; higher (−30) cuts the quiet tail off sooner. Liquidsoap: cue_out_threshold.",
  "audio.autocue.crossThreshold":
    "When the next song starts: the moment the outro has dropped this many dB below the track's average. −7 starts early (long, overlapping crossfades); −15 waits until the outro is quieter (shorter, tighter crossfades). Liquidsoap: cross_threshold.",
  "audio.autocue.maxOverlap":
    "The longest two songs may play over each other. A track with a longer fade-out is ended earlier instead. 0 turns crossfading off. Applied to playout immediately.",
  "audio.autocue.sustainedEndings":
    "Songs that end on a long held note or a slow fade are detected and allowed to ring out further before the next song starts, instead of being cut at the normal crossfade point. Liquidsoap: sustained_endings_enabled.",
  "live.duckDb":
    "How much quieter the music gets while you talk in duck mode (and under voice-overs). −12 dB is clearly in the background; −20 dB is almost gone.",
  "live.duckAttackMs":
    "How fast the music goes down when you start talking. Short (50 ms) ducks almost instantly.",
  "live.duckReleaseMs":
    "How fast the music comes back up after you stop talking. Longer (500–1000 ms) sounds smoother and avoids pumping between words.",
  "live.noShowGraceSeconds":
    "During a scheduled live hour: if no DJ is connected this many seconds after the hour starts, an alert is raised. Fallback music keeps playing either way.",
  "requests.enabled": "Lets listeners request songs on the public listener page.",
  "requests.autoApprove":
    "Requests go straight into the queue. Off: they wait in Requests until someone approves them.",
  "requests.cooldownMinutes":
    "After a request, the same listener (IP address) has to wait this many minutes before the next one. 0 = no waiting.",
  "requests.maxPerHour":
    "Most requests one listener (IP address) can make per hour, on top of the cooldown.",
  "requests.profanityFilter": "Rejects requests and dedications containing swear words.",
  "requests.dedications":
    'Listeners may add a name and short message ("for Anna, happy birthday") to a request.',
  "retention.historyDays":
    "How long the play history (what was played when), listener statistics and the news-timing log are kept for reports. Older entries are deleted by the nightly clean-up.",
  "retention.logsDays":
    "How long ended login sessions, revoked app connections and old password-reset links are kept before the nightly clean-up deletes them. The audit log is kept.",
  "retention.requestsDays":
    "How long handled listener requests are kept before they are deleted. Requests still waiting for approval are never removed.",
  "retention.recordingsDays":
    "How long recordings of live shows are kept before the files are deleted.",
  "backups.dailyKeep": "Number of daily database backups to keep; older ones are deleted.",
  "backups.weeklyKeep": "Number of weekly database backups to keep, on top of the daily ones.",
  "alerts.emailTo":
    "Who gets an e-mail for important alerts (dead air, emergency, encoder or Stereo Tool trouble). One address per line; needs SMTP in secrets.env.",
  "alerts.dedupeSeconds":
    "The same alert is not repeated within this many seconds, so a flapping problem doesn't flood your inbox. A worse severity is always sent.",
};

export class SettingsService {
  constructor(
    private readonly repos: Repositories,
    private readonly worker: WorkerClient | null,
  ) {}

  get<T>(key: SettingKey, fallback: T): T {
    return this.repos.settings.get(key, fallback);
  }

  /** All typed settings grouped by category, with labels for the UI. */
  list(category?: string): {
    key: string;
    value: unknown;
    category: string;
    label: string;
    help: string;
    reloadsWorker: boolean;
  }[] {
    return (
      Object.entries(SETTING_DEFINITIONS) as [
        SettingKey,
        (typeof SETTING_DEFINITIONS)[SettingKey],
      ][]
    )
      .filter(([, d]) => !category || d.category === category)
      .map(([key, d]) => ({
        key,
        value: this.repos.settings.get(key, "default" in d ? d.default : null),
        category: d.category,
        label: d.label,
        help: SETTING_HELP[key],
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
        // A new loudness target applies to the whole library at once (same clamp as gainFor).
        if (key === "audio.targetLufs")
          this.repos.db
            .prepare(
              "UPDATE media SET gain_db = ROUND(MAX(-24, MIN(12, ? - loudness_lufs)), 2) WHERE loudness_lufs IS NOT NULL",
            )
            .run(value);
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
