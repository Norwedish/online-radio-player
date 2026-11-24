import { z } from "zod";

/**
 * Station configuration schema (PLAN 6.11 / M1.1).
 *
 * `config/station.example.json` is validated against this schema. Secrets never
 * live in the JSON: any field ending in `Env` names an environment variable
 * (or a key in `/etc/radio/secrets.env`), which is checked at startup.
 *
 * Two schema decisions come straight from the M0 spikes:
 *  - ADR 0001 — every Icecast mount carries an explicit `contentType`, because
 *    FFmpeg's `icecast://` muxer defaults to `audio/mpeg` without setting it.
 *  - ADR 0003 — HLS is an optional output behind a flag, default **off**.
 */
export const STATION_CONFIG_VERSION = 1;

const SECRET_ENV_NAME = /^[A-Z][A-Z0-9_]{2,}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const BITRATE_PATTERN = /^\d{2,4}k$/;
const PATH_PATTERN = /^\/[A-Za-z0-9 ._/-]+$/;

/** Named environment variables that hold secrets (never stored in the JSON). */
const envName = (description: string) =>
  z
    .string()
    .regex(SECRET_ENV_NAME)
    .describe(`${description}: environment variable name, e.g. ICECAST_SOURCE_PASSWORD`);

const hourPattern = z.string().regex(TIME_PATTERN).describe("HH:MM in the station timezone");

const pathValue = (description: string) =>
  z
    .string()
    .regex(PATH_PATTERN)
    .describe(`${description}: absolute POSIX path (the deploy target is Debian 13)`);

/** ── Station identity / branding ────────────────────────────────────────── */
const stationIdentitySchema = z
  .object({
    id: z
      .number()
      .int()
      .positive()
      .default(1)
      .describe("Single-station schema keeps room for more"),
    name: z.string().min(2).describe("Human-readable station name"),
    timezone: z.string().min(3).default("Europe/Amsterdam"),
    locale: z.string().min(2).default("en"),
    domain: z
      .string()
      .regex(/^[\w.-]+\.[a-z]{2,}$/i)
      .default("radio.example.com"),
    logoUrl: z.string().optional(),
    colors: z
      .object({
        primary: z.string().default("#22c55e"),
        background: z.string().default("#0b0f0e"),
      })
      .default({ primary: "#22c55e", background: "#0b0f0e" }),
  })
  .strict()
  .describe("Station identity (one station in v1, station_id kept for schema stability)");

/** ── Audio / PCM contract ───────────────────────────────────────────────── */
const audioSchema = z
  .object({
    sampleRate: z.union([z.literal(48000), z.literal(44100)]).default(48000),
    channels: z.literal(2).describe("PCM contract is 48 kHz / 16-bit / 2-channel (ADR 0001)"),
    format: z
      .literal("s16le")
      .default("s16le")
      .describe("Raw PCM framing handed to Stereo Tool and the encoder hub"),
    mixFrames: z
      .number()
      .int()
      .gte(1)
      .lte(1024)
      .default(64)
      .describe("Mixer frame size in 1/48 s chunks"),
    bufferMs: z.number().int().gte(20).lte(1000).default(100),
    masterGain: z.number().gt(0).lte(4).default(1),
    targetLufs: z.number().gt(-40).lt(0).default(-16),
    boundaryToleranceSeconds: z
      .number()
      .int()
      .gte(0)
      .lte(300)
      .default(45)
      .describe("PLAN 6.4.5: hour-boundary overrun tolerance before a forced cut"),
    silenceThresholdDb: z.number().gt(-100).lte(0).default(-60),
    silenceSeconds: z.number().int().gte(1).lte(120).default(10),
    emergencyFile: pathValue("Emergency/backup loop file played on silence or failure"),
  })
  .strict()
  .describe("Audio clock and PCM contract");

/** ── Thimeo Stereo Tool ─────────────────────────────────────────────────── */
const stereotoolSchema = z
  .object({
    enabled: z.boolean().default(true),
    binary: pathValue("stereotool_cmd path"),
    preset: pathValue("Preset .sds path"),
    license: pathValue("Stereo Tool license .lic path"),
    edition: z
      .union([z.literal("live"), z.literal("free"), z.literal("unknown")])
      .default("unknown")
      .describe("Detected at install time; 'live' is the licensed purchase"),
    inputMode: z
      .union([z.literal("plugin"), z.literal("stdio-pcm")])
      .default("plugin")
      .describe(
        "'plugin' = Thimeo generic plugin library (libStereoTool_*.so, like Liquidsoap/AzuraCast); 'stdio-pcm' = legacy stereotool_cmd binary",
      ),
    library: pathValue("libStereoTool shared library (.so) for inputMode 'plugin'").default(
      "/opt/stereotool/libStereoTool_intel64.so",
    ),
    presetLoadType: z
      .union([
        z.literal("totalinit"),
        z.literal("all_settings"),
        z.literal("audiofm"),
        z.literal("audio"),
        z.literal("processing"),
        z.number().int().nonnegative(),
      ])
      .default("totalinit")
      .describe(
        "Which parts of the preset to load (plugin mode); a number is passed to stereoTool_LoadPreset as-is",
      ),
    args: z
      .array(z.string())
      .default(["-", "-", "-s", "{preset}"])
      .describe(
        "stereotool_cmd arguments; placeholders {preset} {license} {licenseKey} {rate} {channels}. Confirm against the licensed binary (M0.5)",
      ),
    wavIo: z
      .boolean()
      .default(true)
      .describe("Wrap stdin in a streaming WAV header and strip the WAV header from stdout"),
    licenseKeyEnv: envName("Stereo Tool license key").default("STEREOTOOL_LICENSE_KEY"),
    restart: z
      .object({
        maxAttempts: z.number().int().gte(0).lte(20).default(5),
        backoffMs: z.number().int().gte(200).lte(60_000).default(2000),
      })
      .strict()
      .default({ maxAttempts: 5, backoffMs: 2000 }),
    bypassOnFailure: z
      .boolean()
      .default(true)
      .describe("If Stereo Tool dies, keep the station on air with bypassed audio"),
  })
  .strict()
  .describe("Stereo Tool adapter (ADR 0002 decides the transport)");

/** ── Icecast mounts + HLS ───────────────────────────────────────────────── */
const mountSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*\.(mp3|ogg|aac)$/)
      .describe("Mount name without leading slash, extension matches the codec"),
    codec: z.union([z.literal("mp3"), z.literal("opus"), z.literal("aac")]),
    bitrate: z.string().regex(BITRATE_PATTERN).describe("e.g. 320k, 128k, 96k"),
    contentType: z
      .union([z.literal("audio/mpeg"), z.literal("audio/ogg"), z.literal("audio/aac")])
      .describe("ADR 0001: pass -content_type explicitly on every icecast:// output"),
    public: z.boolean().default(true),
    primary: z.boolean().default(false),
  })
  .strict();

/** Cross-field consistency the schema cannot express in zod 3 (ADR 0001 rule). */
const MOUNT_CODEC_CONTRACT: Record<string, { contentType: string; extension: string }> = {
  mp3: { contentType: "audio/mpeg", extension: ".mp3" },
  opus: { contentType: "audio/ogg", extension: ".ogg" },
  aac: { contentType: "audio/aac", extension: ".aac" },
};

const hlsSchema = z
  .object({
    enabled: z
      .boolean()
      .default(false)
      .describe("ADR 0003: HLS ships as an optional output; MP3/Opus mounts stay primary"),
    mount: z
      .string()
      .regex(/^\/[a-z0-9/-]+$/)
      .default("/hls"),
    segmentSeconds: z.number().int().gte(1).lte(10).default(2),
    listSize: z.number().int().gte(3).lte(30).default(6),
    codec: z.literal("aac").default("aac"),
    bitrate: z.string().regex(BITRATE_PATTERN).default("96k"),
    nginxServer: z.string().default("radio-hls"),
  })
  .strict()
  .default({ enabled: false })
  .describe("FFmpeg segmenter + nginx static serving (Icecast has no HLS upstream)");

const icecastSchema = z
  .object({
    host: z.string().min(3).default("127.0.0.1"),
    port: z.number().int().gte(1024).lte(29_999).default(8000),
    sourcePasswordEnv: envName("Icecast source password"),
    adminUser: z.string().min(1).default("admin"),
    adminPasswordEnv: envName("Icecast admin password"),
    liveMount: z
      .string()
      .regex(/^\/live[a-z0-9-]*$/)
      .default("/live")
      .describe("ADR 0004: external DJ ingest mount, one source password per session"),
    livePasswordEnv: envName("Base env name for per-DJ-session source passwords"),
    mounts: z.array(mountSchema).min(1).max(8),
    hls: hlsSchema,
  })
  .strict()
  .describe("Icecast 2.5/2.6 target (dev container runs 2.4.4)");

/** ── Media library ──────────────────────────────────────────────────────── */
const mediaSchema = z
  .object({
    root: pathValue("Media library root"),
    nasPaths: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9-]{2,32}$/),
            mountPath: pathValue("Where the NAS export is mounted on this host"),
            relativePath: z
              .string()
              .regex(/^\/[A-Za-z0-9 ._/-]*$/)
              .default("/"),
            enabled: z.boolean().default(true),
          })
          .strict(),
      )
      .default([])
      .describe("NAS/SMB/NFS sources"),
    watchFolder: pathValue("Drop-folder ingested on every scan"),
    scanIntervalSeconds: z.number().int().gte(30).lte(86_400).default(300),
    maxScanFiles: z.number().int().gte(100).lte(500_000).default(100_000),
    artworkDir: pathValue("Artwork cache directory"),
    extensions: z
      .array(z.string().regex(/^\.(mp3|flac|m4a|aac|ogg|opus|wav)$/))
      .default([".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wav"]),
    metadataLookup: z
      .object({
        musicbrainz: z.boolean().default(true),
        rateLimitPerMinute: z.number().int().gte(0).lte(2).default(1),
      })
      .strict()
      .default({ musicbrainz: true, rateLimitPerMinute: 1 }),
  })
  .strict()
  .describe("Library ingestion (M2)");

/** ── Scheduler / generator ─────────────────────────────────────────────── */
const generatorSchema = z
  .object({
    generateHour00At: hourPattern,
    generateRestAt: hourPattern,
    separationTrackHours: z.number().int().gte(0).lte(24).default(4),
    separationArtistHours: z.number().int().gte(0).lte(24).default(1),
    hourMinSeconds: z.number().int().gte(3000).lte(3600).default(3540),
    hourMaxSeconds: z.number().int().gte(3600).lte(3900).default(3720),
    overrunAllowedSeconds: z.number().int().gte(0).lte(600).default(90),
    tailWindowSeconds: z.number().int().gte(60).lte(900).default(300),
    tailOverrunSeconds: z.number().int().gte(0).lte(300).default(45),
    newsReserveSeconds: z.number().int().gte(0).lte(900).default(180),
    fallbackPlaylistName: z.string().default("General"),
    decadePrefixes: z
      .array(z.string().regex(/^\d\ds$/))
      .default(["00s", "10s", "20s", "30s", "40s", "50s", "60s", "70s", "80s", "90s"])
      .describe("playlist_maker naming: 00s-90s decade buckets"),
  })
  .strict();

const newsSchema = z
  .object({
    fullHourFile: pathValue("Hour-head news jingle"),
    halfHourFile: pathValue("Half-hour news jingle"),
    lockedMinutes: z
      .array(z.number().int().gte(0).lt(60))
      .default([0, 30])
      .describe("PLAN 6.4.5: news blocks are locked at :00 and :30"),
  })
  .strict()
  .default({
    fullHourFile: "/Nieuws/nieuws-heel-uur.mp3",
    halfHourFile: "/Nieuws/nieuws-half-uur.mp3",
    lockedMinutes: [0, 30],
  });

const liveSchema = z
  .object({
    maxConcurrent: z.literal(1).default(1).describe("One DJ at a time (M8)"),
    duckDb: z.number().int().gt(-36).lt(0).default(-12),
    duckAttackMs: z.number().int().gte(10).lte(1000).default(50),
    duckReleaseMs: z.number().int().gte(100).lte(5000).default(500),
    noShowGraceSeconds: z.number().int().gte(0).lte(900).default(120),
    noShowFallbackPlaylistName: z.string().nullable().default(null),
    studio: z
      .object({
        jitterBufferMs: z
          .number()
          .int()
          .gte(100)
          .lte(500)
          .default(200)
          .describe("ADR 0004: WS PCM jitter buffer, 150-250 ms recommended"),
        channels: z.union([z.literal(1), z.literal(2)]).default(2),
        maxSessionMinutes: z.number().int().gte(5).lte(600).default(180),
      })
      .strict()
      .default({ jitterBufferMs: 200, channels: 2, maxSessionMinutes: 180 }),
  })
  .strict()
  .default({
    maxConcurrent: 1,
    duckDb: -12,
    duckAttackMs: 50,
    duckReleaseMs: 500,
    noShowGraceSeconds: 120,
    noShowFallbackPlaylistName: null,
    studio: { jitterBufferMs: 200, channels: 2, maxSessionMinutes: 180 },
  });

const schedulerSchema = z
  .object({ generator: generatorSchema, news: newsSchema, live: liveSchema })
  .strict()
  .describe("24x1h generator and hour-boundary rules");

/** ── Requests ───────────────────────────────────────────────────────────── */
const requestsSchema = z
  .object({
    enabled: z.boolean().default(true),
    autoApprove: z.boolean().default(false),
    blacklistPatterns: z
      .array(z.string().min(1))
      .default([])
      .describe("Always-rejected artists/titles, checked even when autoApprove is on"),
    cooldownMinutes: z.number().int().gte(0).lte(1440).default(60),
    maxPerHour: z.number().int().gte(0).lte(100).default(3),
    maxPerIpPerDay: z.number().int().gte(0).lte(100).default(10),
    profanityFilter: z.boolean().default(true),
    dedications: z.boolean().default(true),
    maxLengthCharacters: z.number().int().gte(20).lte(2000).default(500),
  })
  .strict()
  .describe("Moderated listener requests");

/** ── Retention, backups ─────────────────────────────────────────────────── */
const retentionSchema = z
  .object({
    historyDays: z.number().int().gte(1).lte(3650).default(90),
    logsDays: z.number().int().gte(1).lte(365).default(30),
    requestsDays: z.number().int().gte(1).lte(365).default(30),
    recordingsDays: z.number().int().gte(1).lte(365).default(30),
    hlsSegments: z
      .number()
      .int()
      .gte(1)
      .lte(60)
      .default(6)
      .describe("Kept by the segmenter itself"),
  })
  .strict()
  .default({ historyDays: 90, logsDays: 30, requestsDays: 30, recordingsDays: 30, hlsSegments: 6 });

const backupsSchema = z
  .object({
    dir: pathValue("Backup directory (local disk only, never SMB/NFS — ADR 0005)"),
    dailyKeep: z.number().int().gte(1).lte(365).default(14),
    weeklyKeep: z.number().int().gte(1).lte(120).default(8),
    minFreeDiskB: z.number().int().gte(1_000_000).default(500_000_000),
  })
  .strict()
  .default({ dir: "/srv/radio/backups", dailyKeep: 14, weeklyKeep: 8, minFreeDiskB: 500_000_000 });

/** ── Email, webhooks, metrics, alerts ──────────────────────────────────── */
const emailSchema = z
  .object({
    smtpHost: z.string().min(3).default("smtp.example.com"),
    smtpPort: z.number().int().gte(1).lte(65_535).default(587),
    smtpSecure: z.boolean().default(true),
    from: z
      .string()
      .regex(/^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i)
      .default("radio@example.com"),
    authUserEnv: envName("SMTP user").default("SMTP_USER"),
    authPasswordEnv: envName("SMTP password").default("SMTP_PASSWORD"),
    resetSubject: z.string().default("Radio station password reset"),
  })
  .strict()
  .default({
    smtpHost: "smtp.example.com",
    smtpPort: 587,
    smtpSecure: true,
    from: "radio@example.com",
    authUserEnv: "SMTP_USER",
    authPasswordEnv: "SMTP_PASSWORD",
    resetSubject: "Radio station password reset",
  });

const webhooksSchema = z
  .object({
    alerts: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9-]{2,32}$/),
            urlEnv: envName("Webhook target URL"),
            minSeverity: z
              .union([
                z.literal("info"),
                z.literal("warning"),
                z.literal("error"),
                z.literal("critical"),
              ])
              .default("warning"),
            secretEnv: envName("Webhook signing secret").nullable().default(null),
          })
          .strict(),
      )
      .default([]),
  })
  .strict()
  .default({ alerts: [] });

const alertsSchema = z
  .object({
    inApp: z.boolean().default(true),
    email: z.boolean().default(true),
    emailTo: z
      .array(z.string().regex(/^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i))
      .default([])
      .describe("Recipients; empty means 'do not email alerts'"),
    syslogTag: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{1,30}$/)
      .default("radio-player"),
    prometheusEnabled: z.boolean().default(true),
    dedupeSeconds: z.number().int().gte(0).lte(3600).default(300),
  })
  .strict()
  .default({
    inApp: true,
    email: true,
    emailTo: [],
    syslogTag: "radio-player",
    prometheusEnabled: true,
    dedupeSeconds: 300,
  });

const metricsSchema = z
  .object({
    enabled: z.boolean().default(true),
    path: z
      .string()
      .regex(/^\/[a-z0-9/_-]*$/)
      .default("/metrics"),
    listenerSampleSeconds: z.number().int().gte(5).lte(3600).default(30),
  })
  .strict()
  .default({ enabled: true, path: "/metrics", listenerSampleSeconds: 30 });

/** ── Auth / users ──────────────────────────────────────────────────────── */
/** Bearer tokens for the mobile / remote-control app (device grants). */
const APP_TOKEN_DEFAULTS = {
  enabled: true,
  accessTokenMinutes: 60,
  refreshTokenDays: 90,
  pairingCodeMinutes: 10,
  maxDevicesPerUser: 10,
};
const appTokensSchema = z
  .object({
    enabled: z.boolean().default(true).describe("Allow apps to sign in with bearer tokens"),
    accessTokenMinutes: z.number().int().gte(5).lte(1440).default(60),
    refreshTokenDays: z
      .number()
      .int()
      .gte(1)
      .lte(365)
      .default(90)
      .describe("A device unused this long must sign in again"),
    pairingCodeMinutes: z.number().int().gte(2).lte(60).default(10),
    maxDevicesPerUser: z.number().int().gte(1).lte(100).default(10),
  })
  .strict()
  .default(APP_TOKEN_DEFAULTS);

const usersSchema = z
  .object({
    bootstrapAdminUserEnv: envName("Bootstrap admin username"),
    bootstrapAdminPasswordEnv: envName("Bootstrap admin password"),
    totpAllowed: z.boolean().default(true),
    sessionHours: z.number().int().gte(1).lte(240).default(12),
    emailResetEnabled: z.boolean().default(true),
    passwordMinLength: z.number().int().gte(8).lte(128).default(12),
    appTokens: appTokensSchema,
  })
  .strict()
  .default({
    bootstrapAdminUserEnv: "ADMIN_USERNAME",
    bootstrapAdminPasswordEnv: "ADMIN_PASSWORD",
    totpAllowed: true,
    sessionHours: 12,
    emailResetEnabled: true,
    passwordMinLength: 12,
    appTokens: APP_TOKEN_DEFAULTS,
  });

/** ── Web UI / worker plumbing ──────────────────────────────────────────── */
const webSchema = z
  .object({
    publicBaseUrl: z
      .string()
      .regex(/^https?:\/\/[\w./-]+$/)
      .default("https://radio.example.com/listen"),
    adminPath: z
      .string()
      .regex(/^\/admin$/)
      .default("/admin"),
    listenPath: z
      .string()
      .regex(/^\/listen$/)
      .default("/listen"),
    studioPath: z
      .string()
      .regex(/^\/studio$/)
      .default("/studio"),
    cspAllowHlsFrom: z.array(z.string().regex(/^https?:\/\/[\w./*-]+$/)).default([]),
  })
  .strict()
  .default({
    publicBaseUrl: "https://radio.example.com/listen",
    adminPath: "/admin",
    listenPath: "/listen",
    studioPath: "/studio",
    cspAllowHlsFrom: [],
  });

const workerSchema = z
  .object({
    heartbeatMs: z.number().int().gte(1000).lte(600_000).default(10_000),
    protocolPort: z.number().int().gte(1025).lte(29_999).default(3101),
    logDir: pathValue("Worker log directory").default("/srv/radio/logs"),
    keepWorkersAliveSeconds: z.number().int().gte(1).lte(3600).default(30),
  })
  .strict()
  .default({
    heartbeatMs: 10_000,
    protocolPort: 3101,
    logDir: "/srv/radio/logs",
    keepWorkersAliveSeconds: 30,
  });

const databaseSchema = z
  .object({
    file: pathValue("SQLite database file (local disk only — ADR 0005)"),
    backupDir: pathValue("Backup directory (local disk only — ADR 0005)"),
  })
  .strict()
  .default({ file: "/srv/radio/var/radio.sqlite", backupDir: "/srv/radio/backups" });

/** ── Top level ─────────────────────────────────────────────────────────── */
export const stationConfigSchema = z
  .object({
    configVersion: z
      .number()
      .int()
      .positive()
      .default(STATION_CONFIG_VERSION)
      .describe("Bumped when breaking config changes land"),
    station: stationIdentitySchema,
    audio: audioSchema,
    stereotool: stereotoolSchema,
    icecast: icecastSchema,
    media: mediaSchema,
    scheduler: schedulerSchema,
    requests: requestsSchema,
    retention: retentionSchema,
    backups: backupsSchema,
    email: emailSchema,
    webhooks: webhooksSchema,
    alerts: alertsSchema,
    metrics: metricsSchema,
    users: usersSchema,
    web: webSchema,
    worker: workerSchema,
    db: databaseSchema,
  })
  .strict()
  .describe("Full station configuration");

/** Cross-field rules zod 3 cannot express; checked after structural parsing. */
export function stationConfigCrossFieldIssues(config: StationConfig): string[] {
  const issues: string[] = [];
  if (config.backups.dir !== config.db.backupDir) {
    issues.push(
      `backups.dir must equal db.backupDir (got ${config.backups.dir} and ${config.db.backupDir})`,
    );
  }
  const primaries = config.icecast.mounts.filter((mount) => mount.primary);
  if (primaries.length !== 1) {
    issues.push(`exactly one icecast mount must set primary:true (found ${primaries.length})`);
  }
  for (const mount of config.icecast.mounts) {
    const contract = MOUNT_CODEC_CONTRACT[mount.codec] ?? { contentType: "", extension: "" };
    if (mount.contentType !== contract.contentType) {
      issues.push(
        `${mount.codec} mount ${mount.name} must use contentType ${contract.contentType} (ADR 0001)`,
      );
    }
    if (!mount.name.endsWith(contract.extension)) {
      issues.push(
        `mount ${mount.name} extension must be ${contract.extension} for codec ${mount.codec}`,
      );
    }
  }
  const mountNames = new Set(config.icecast.mounts.map((mount) => mount.name));
  if (mountNames.size !== config.icecast.mounts.length) {
    issues.push("icecast mount names must be unique");
  }
  if (config.icecast.port === config.worker.protocolPort) {
    issues.push("icecast.port and worker.protocolPort must differ");
  }
  if (config.scheduler.generator.hourMinSeconds > config.scheduler.generator.hourMaxSeconds) {
    issues.push("scheduler.generator.hourMinSeconds must not exceed hourMaxSeconds");
  }
  const nasIds = new Set(config.media.nasPaths.map((entry) => entry.id));
  if (nasIds.size !== config.media.nasPaths.length) {
    issues.push("media.nasPaths ids must be unique");
  }
  const webhookIds = new Set(config.webhooks.alerts.map((entry) => entry.id));
  if (webhookIds.size !== config.webhooks.alerts.length) {
    issues.push("webhooks.alerts ids must be unique");
  }
  return issues;
}

export type StationConfig = z.infer<typeof stationConfigSchema>;

/** Flattens a Zod issue into `path.to.key: message` lines for the CLI/API. */
export function formatConfigErrors(error: z.ZodError, path = "config"): string[] {
  return error.issues.map((issue) => {
    const key = [path, ...issue.path].join(".");
    const suffix = issue.code ? ` (${issue.code})` : "";
    return `${key}: ${issue.message}${suffix}`;
  });
}

/** Parse + default an already-parsed JSON value. */
export function parseStationConfig(input: unknown):
  | { ok: true; config: StationConfig }
  | {
      ok: false;
      errors: string[];
    } {
  const result = stationConfigSchema.safeParse(input);
  if (!result.success) {
    return { ok: false, errors: formatConfigErrors(result.error) };
  }
  const crossField = stationConfigCrossFieldIssues(result.data);
  if (crossField.length > 0) {
    return { ok: false, errors: crossField };
  }
  return { ok: true, config: result.data };
}
