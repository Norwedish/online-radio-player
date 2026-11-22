/** Builds every API service around one DB handle and one worker connection. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  createRepositories,
  openDatabase,
  runMigrations,
  seedDatabase,
  type Repositories,
} from "@radio/db";
import { secret, type RuntimeConfig } from "@radio/shared";
import { AlertService } from "./services/alerts.js";
import { AuthService } from "./services/auth.js";
import { EventBus } from "./services/bus.js";
import { EventService } from "./services/events.js";
import { GeneratorScheduler, GeneratorService } from "./services/generator.js";
import { LiveService } from "./services/live.js";
import { Mailer } from "./services/mailer.js";
import { MediaWatcher } from "./services/media/watcher.js";
import { Metrics } from "./services/metrics.js";
import { RequestService } from "./services/requests.js";
import { SettingsService } from "./services/settings.js";
import { StationSync } from "./services/station-sync.js";
import { WorkerClient } from "./worker-client.js";

export interface AppContext {
  config: RuntimeConfig;
  repos: Repositories;
  worker: WorkerClient;
  bus: EventBus;
  metrics: Metrics;
  mailer: Mailer;
  alerts: AlertService;
  auth: AuthService;
  settings: SettingsService;
  generator: GeneratorService;
  generatorScheduler: GeneratorScheduler;
  requests: RequestService;
  live: LiveService;
  events: EventService;
  sync: StationSync;
  watcher: MediaWatcher;
  log: (m: string) => void;
  startedAt: number;
  close(): Promise<void>;
}

export interface ContextOptions {
  log?: (m: string) => void;
  fetchImpl?: typeof fetch;
  workerEndpoint?: { socket: string } | { port: number; host?: string };
  /** Seed + bootstrap admin from env on startup (default true). */
  seed?: boolean;
}

export async function createContext(
  config: RuntimeConfig,
  options: ContextOptions = {},
): Promise<AppContext> {
  const log = options.log ?? ((m: string) => console.log(`${new Date().toISOString()} [api] ${m}`));
  mkdirSync(dirname(config.db.file), { recursive: true });
  runMigrations(config.db.file);
  const db = openDatabase(config.db.file);
  if (options.seed !== false) {
    const user = secret(config.users.bootstrapAdminUserEnv);
    const password = secret(config.users.bootstrapAdminPasswordEnv);
    await seedDatabase(db, {
      stationName: config.station.name,
      timezone: config.station.timezone,
      locale: config.station.locale,
      admin:
        user && password && password.length >= config.users.passwordMinLength
          ? { username: user, password, email: process.env.ADMIN_EMAIL }
          : null,
    });
  }
  const repos = createRepositories(db, config.station.id);
  const metrics = new Metrics();
  const bus = new EventBus();
  const mailer = new Mailer(config, log);
  const worker = new WorkerClient(
    options.workerEndpoint ??
      (config.workerSocket
        ? { socket: config.workerSocket }
        : { port: config.worker.protocolPort }),
    { token: process.env.PLAYOUT_TOKEN, log },
  );
  const alerts = new AlertService(repos, config, bus, mailer, metrics, options.fetchImpl);
  const raise = (a: Parameters<AlertService["raise"]>[0]) => void alerts.raise(a);
  const generator = new GeneratorService(repos, config, raise, () => {
    if (worker.connected) void worker.send("queue:reload").catch(() => {});
    bus.publish("playout", "plans:changed", {});
  });
  const generatorScheduler = new GeneratorScheduler(generator, repos, log);
  const settings = new SettingsService(repos, worker);
  const auth = new AuthService(repos, config, mailer);
  const requests = new RequestService(repos, config, worker, bus);
  const events = new EventService(repos, worker, bus, log);
  const live = new LiveService(repos, config, worker, alerts, generator);
  const sync = new StationSync(
    repos,
    config,
    worker,
    bus,
    alerts,
    requests,
    events,
    metrics,
    log,
    options.fetchImpl,
  );
  const watcher = new MediaWatcher(repos, config, (ids) =>
    bus.publish("media", "media:imported", { ids }),
  );
  return {
    config,
    repos,
    worker,
    bus,
    metrics,
    mailer,
    alerts,
    auth,
    settings,
    generator,
    generatorScheduler,
    requests,
    live,
    events,
    sync,
    watcher,
    log,
    startedAt: Date.now(),
    async close() {
      generatorScheduler.stop();
      sync.stop();
      worker.close();
      await watcher.stop();
      db.close();
    },
  };
}
