/**
 * Background jobs owned by radio-api (the single DB writer): generator
 * triggers + integrity, events, live no-show, loudness backfill, retention
 * (daily), recordings purge, session purge, disk-space alert.
 */
import { statfsSync } from "node:fs";
import { runRetention } from "@radio/db";
import type { AppContext } from "./context.js";
import { analyzePending } from "./services/media/loudness.js";
import { scanLibraryOnce } from "./services/media/scanner.js";
import { NewsRefresher } from "./services/media/news-refresh.js";
import { runBackup } from "./routes/operations.js";

export function startJobs(ctx: AppContext, options: { backups?: boolean } = {}): () => void {
  const timers: NodeJS.Timeout[] = [];
  const safe = (name: string, fn: () => unknown) => async () => {
    try {
      await fn();
    } catch (e) {
      ctx.log(`job ${name} failed: ${(e as Error).message}`);
    }
  };
  ctx.generatorScheduler.start();
  timers.push(
    setInterval(
      safe("events", () => ctx.events.tick()),
      15_000,
    ),
  );
  timers.push(
    setInterval(
      safe("live-no-show", () => ctx.live.checkNoShow()),
      30_000,
    ),
  );
  // Periodic library scan (media.scanIntervalSeconds): picks up files added to a network
  // share by other computers, where file-change notifications never arrive. Unchanged files
  // are skipped by size + modification time, so a rescan is cheap.
  timers.push(
    setInterval(
      safe("media-scan", async () => {
        const r = await scanLibraryOnce(ctx.repos, ctx.config);
        if (r && (r.created || r.updated || r.missing)) {
          ctx.log(`scan: ${r.created} new, ${r.updated} updated, ${r.missing} missing`);
          ctx.bus.publish("media", "media:scan-done", { ...r, errors: r.errors.slice(0, 20) });
        }
      }),
      ctx.config.media.scanIntervalSeconds * 1000,
    ),
  );
  // News bulletins change under the same name many times a day: check them every 10 s and
  // analyse a new version as soon as it is completely written.
  const news = new NewsRefresher(
    ctx.repos,
    ctx.config,
    () => {
      const s = ctx.generator.settings();
      return [s.news_path_hour, s.news_path_half];
    },
    () => ctx.repos.settings.get("audio.targetLufs", ctx.config.audio.targetLufs),
    ctx.log,
  );
  timers.push(
    setInterval(
      safe("news-refresh", () => news.check()),
      10_000,
    ),
  );
  let analyzing = false;
  timers.push(
    setInterval(
      safe("loudness", async () => {
        if (analyzing) return;
        analyzing = true;
        try {
          await analyzePending(
            ctx.repos,
            ctx.repos.settings.get("audio.targetLufs", ctx.config.audio.targetLufs),
            5,
          );
        } finally {
          analyzing = false;
        }
      }),
      20_000,
    ),
  );
  const daily = safe("retention", () => {
    const report = runRetention(ctx.repos.db, {
      historyDays: ctx.repos.settings.get(
        "retention.historyDays",
        ctx.config.retention.historyDays,
      ),
      requestsDays: ctx.repos.settings.get(
        "retention.requestsDays",
        ctx.config.retention.requestsDays,
      ),
      logsDays: ctx.repos.settings.get("retention.logsDays", ctx.config.retention.logsDays),
    });
    const recordings = ctx.live.purgeRecordings();
    ctx.log(`retention: ${JSON.stringify({ ...report, recordings })}`);
    ctx.repos.audit.write({
      userId: null,
      action: "retention.run",
      metadata: { ...report, recordings },
    });
  });
  timers.push(setInterval(daily, 6 * 3_600_000));
  setTimeout(daily, 60_000);
  timers.push(
    setInterval(
      safe("disk", () => {
        const st = statfsSync(ctx.config.dataDir);
        const free = st.bavail * st.bsize;
        ctx.metrics.set("radio_disk_free_bytes", free);
        if (free < ctx.config.backups.minFreeDiskB)
          void ctx.alerts.raise({
            type: "disk_low",
            severity: "warning",
            message: `Low disk space: ${(free / 1e9).toFixed(1)} GB free in ${ctx.config.dataDir}`,
          });
        else ctx.alerts.resolve("disk_low");
      }),
      10 * 60_000,
    ),
  );
  if (options.backups) {
    // Fallback when the systemd backup timer is not installed (e.g. dev, containers).
    timers.push(
      setInterval(
        safe("backup", () => runBackup(ctx, ctx.repos)),
        24 * 3_600_000,
      ),
    );
  }
  return () => timers.forEach((t) => clearInterval(t));
}
