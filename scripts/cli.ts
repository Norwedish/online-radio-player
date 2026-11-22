/**
 * Station CLI (PLAN M1.6, M2, M3.7). Run via the root package scripts:
 *
 *   pnpm db:seed                         seed station/playlists/slots/settings + bootstrap admin
 *   pnpm db:backup [--dir DIR]           online backup + rotation
 *   pnpm db:restore --file FILE          offline restore (stop radio-api first)
 *   pnpm user:create --username U --email E --role admin|dj|operator [--password P]
 *   pnpm user:password --username U [--password P]
 *   pnpm media:scan [--analyze]          scan media root (+ optional loudness pass)
 *   pnpm generate [--date YYYY-MM-DD] [--hours 0,1] [--dry-run] [--force]
 *   pnpm preview --hours 0,1 [--date YYYY-MM-DD]   alias of generate --dry-run
 *   pnpm retention                        run retention jobs now
 *
 * Root-level scripts import workspace sources by relative path because the
 * root package cannot resolve better-sqlite3 (see scripts/db-migrate.ts).
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { loadRuntimeConfig, ROLES, type Role } from "../packages/shared/src/index.ts";
import {
  backupDatabase,
  createRepositories,
  hashPassword,
  openDatabase,
  restoreDatabase,
  runMigrations,
  runRetention,
  seedDatabase,
} from "../packages/db/src/index.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "true";
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const command = process.argv[2];
const config = loadRuntimeConfig();
const dbFile = arg("db") ?? config.db.file;

function openReady() {
  mkdirSync(dirname(dbFile), { recursive: true });
  runMigrations(dbFile);
  return openDatabase(dbFile);
}

async function main(): Promise<number> {
  switch (command) {
    case "db:seed": {
      const db = openReady();
      const username = process.env.ADMIN_USERNAME;
      const password = process.env.ADMIN_PASSWORD;
      if (password && password.length < config.users.passwordMinLength) {
        console.error(
          `ADMIN_PASSWORD must be at least ${config.users.passwordMinLength} characters`,
        );
        return 1;
      }
      const report = await seedDatabase(db, {
        stationName: config.station.name,
        timezone: config.station.timezone,
        locale: config.station.locale,
        admin: username && password ? { username, password, email: process.env.ADMIN_EMAIL } : null,
        settings: {
          "audio.boundaryToleranceSeconds": config.audio.boundaryToleranceSeconds,
          "audio.silenceThresholdDb": config.audio.silenceThresholdDb,
          "audio.silenceSeconds": config.audio.silenceSeconds,
          "audio.targetLufs": config.audio.targetLufs,
          "live.duckDb": config.scheduler.live.duckDb,
          "requests.autoApprove": config.requests.autoApprove,
          "requests.cooldownMinutes": config.requests.cooldownMinutes,
          "requests.maxPerHour": config.requests.maxPerHour,
        },
      });
      const repos = createRepositories(db);
      console.table([
        {
          ...report,
          slots: repos.schedule.slots().length,
          playlists: repos.playlists.list().length,
          users: repos.users.count(),
        },
      ]);
      if (!username || !password)
        console.log(
          "ADMIN_USERNAME/ADMIN_PASSWORD not set: no admin bootstrapped (use pnpm user:create).",
        );
      db.close();
      return 0;
    }
    case "db:backup": {
      const db = openReady();
      const repos = createRepositories(db);
      const dir = arg("dir") ?? config.backups.dir;
      const result = await backupDatabase(db, dir, {
        dailyKeep: repos.settings.get("backups.dailyKeep", config.backups.dailyKeep),
        weeklyKeep: repos.settings.get("backups.weeklyKeep", config.backups.weeklyKeep),
      });
      repos.backups.record(result.path, "daily", result.size, true);
      if (result.weeklyPath) repos.backups.record(result.weeklyPath, "weekly", result.size, true);
      repos.backups.forget(result.removed);
      console.log(JSON.stringify(result, null, 2));
      db.close();
      return 0;
    }
    case "db:restore": {
      const file = arg("file");
      if (!file || file === "true") {
        console.error("usage: pnpm db:restore --file /srv/radio/backups/radio-....sqlite3");
        return 1;
      }
      const result = restoreDatabase(file, dbFile);
      console.log(JSON.stringify(result, null, 2));
      console.log("Restore complete. Restart services: systemctl restart radio-api radio-playout");
      return 0;
    }
    case "user:create": {
      const username = arg("username");
      const email = arg("email");
      const role = (arg("role") ?? "operator") as Role;
      if (!username || !email || !ROLES.includes(role)) {
        console.error(
          "usage: pnpm user:create --username U --email E --role admin|dj|operator [--password P]",
        );
        return 1;
      }
      const generated = !arg("password");
      const password = arg("password") ?? randomBytes(12).toString("base64url");
      if (password.length < config.users.passwordMinLength) {
        console.error(`password must be at least ${config.users.passwordMinLength} characters`);
        return 1;
      }
      const db = openReady();
      const repos = createRepositories(db);
      if (!repos.stations.get(1))
        await seedDatabase(db, {
          stationName: config.station.name,
          timezone: config.station.timezone,
        });
      const user = repos.users.create({
        username,
        email,
        role,
        passwordHash: await hashPassword(password),
        isActive: true,
      });
      repos.audit.write({
        userId: null,
        action: "user.create",
        entityType: "user",
        entityId: user.id,
        metadata: { username, role, via: "cli" },
      });
      console.log(
        `created ${role} ${username} (id ${user.id})${generated ? `, password: ${password}` : ""}`,
      );
      db.close();
      return 0;
    }
    case "user:password": {
      const username = arg("username");
      if (!username) {
        console.error("usage: pnpm user:password --username U [--password P]");
        return 1;
      }
      const generated = !arg("password");
      const password = arg("password") ?? randomBytes(12).toString("base64url");
      const db = openReady();
      const repos = createRepositories(db);
      const user = repos.users.findByLogin(username);
      if (!user) {
        console.error(`no user ${username}`);
        return 1;
      }
      repos.users.update(user.id, { password_hash: await hashPassword(password), is_active: true });
      repos.sessions.revokeAllForUser(user.id);
      repos.audit.write({
        userId: null,
        action: "user.password_reset",
        entityType: "user",
        entityId: user.id,
        metadata: { via: "cli" },
      });
      console.log(`password updated for ${username}${generated ? `: ${password}` : ""}`);
      db.close();
      return 0;
    }
    case "media:scan": {
      const { scanLibrary } = await import("../apps/api/src/services/media/scanner.ts");
      const { analyzePending } = await import("../apps/api/src/services/media/loudness.ts");
      const db = openReady();
      const repos = createRepositories(db);
      const report = await scanLibrary(repos, config, { log: (m) => console.log(m) });
      console.table([{ ...report, errors: report.errors.length }]);
      for (const e of report.errors.slice(0, 20)) console.log(`  ! ${e}`);
      if (flag("analyze")) {
        let total = 0;
        for (;;) {
          const n = await analyzePending(repos, config.audio.targetLufs, 25);
          total += n;
          if (n === 0) break;
          console.log(`loudness: ${total} analyzed`);
        }
      }
      db.close();
      return 0;
    }
    case "generate":
    case "preview": {
      const { GeneratorService } = await import("../apps/api/src/services/generator.ts");
      const db = openReady();
      const repos = createRepositories(db);
      const service = new GeneratorService(repos, config);
      const hours = arg("hours")
        ?.split(",")
        .map(Number)
        .filter((n) => Number.isInteger(n) && n >= 0 && n < 24);
      const dryRun = command === "preview" || flag("dry-run");
      const result = service.generate({
        date: arg("date"),
        hours,
        dryRun,
        force: flag("force"),
        runType: "cli",
      });
      for (const plan of result.plans) {
        console.log(
          `\n=== ${plan.date} ${String(plan.hour).padStart(2, "0")}:00  ${plan.status}  total ${plan.totalSeconds.toFixed(0)} s${plan.skipped ? `  (skipped: ${plan.skipped})` : ""}`,
        );
        for (const item of plan.items) {
          const mm = Math.floor(item.startSeconds / 60);
          const ss = Math.floor(item.startSeconds % 60);
          console.log(
            `  ${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}  ${item.kind.padEnd(6)} ${item.length.toFixed(0).padStart(4)}s  ${item.artist ?? ""} — ${item.title ?? ""}`,
          );
        }
        for (const w of plan.warnings) console.log(`  ⚠ ${w}`);
      }
      console.log(
        `\n${dryRun ? "dry run: nothing written" : `written: ${result.plans.filter((p) => !p.skipped).length} plans`}`,
      );
      db.close();
      return 0;
    }
    case "retention": {
      const db = openReady();
      const repos = createRepositories(db);
      const report = runRetention(db, {
        historyDays: repos.settings.get("retention.historyDays", config.retention.historyDays),
        requestsDays: repos.settings.get("retention.requestsDays", config.retention.requestsDays),
        logsDays: repos.settings.get("retention.logsDays", config.retention.logsDays),
      });
      console.table([report]);
      db.close();
      return 0;
    }
    default:
      console.error(`unknown command ${command ?? ""}. See scripts/cli.ts header for usage.`);
      return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
