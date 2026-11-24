import type Database from "better-sqlite3";
import { MediaRepository, PlaylistRepository } from "./media.js";
import {
  AlertRepository,
  AuditRepository,
  BackupRepository,
  EventRepository,
  HistoryRepository,
  ListenerStatsRepository,
  LiveSessionRepository,
  RequestRepository,
  SettingsRepository,
  StationRepository,
} from "./ops.js";
import { ScheduleRepository } from "./schedule.js";
import {
  ApiKeyRepository,
  DeviceGrantRepository,
  PasswordResetRepository,
  SessionRepository,
  UserRepository,
} from "./users.js";

export * from "./types.js";
export * from "./media.js";
export * from "./ops.js";
export * from "./schedule.js";
export * from "./users.js";

export interface Repositories {
  db: Database.Database;
  stationId: number;
  stations: StationRepository;
  users: UserRepository;
  sessions: SessionRepository;
  passwordResets: PasswordResetRepository;
  apiKeys: ApiKeyRepository;
  devices: DeviceGrantRepository;
  audit: AuditRepository;
  media: MediaRepository;
  playlists: PlaylistRepository;
  schedule: ScheduleRepository;
  requests: RequestRepository;
  alerts: AlertRepository;
  events: EventRepository;
  history: HistoryRepository;
  listeners: ListenerStatsRepository;
  live: LiveSessionRepository;
  settings: SettingsRepository;
  backups: BackupRepository;
}

/** All repositories scoped to one station (single-station rule, PLAN 2.2). */
export function createRepositories(db: Database.Database, stationId = 1): Repositories {
  return {
    db,
    stationId,
    stations: new StationRepository(db),
    users: new UserRepository(db, stationId),
    sessions: new SessionRepository(db),
    passwordResets: new PasswordResetRepository(db),
    apiKeys: new ApiKeyRepository(db, stationId),
    devices: new DeviceGrantRepository(db),
    audit: new AuditRepository(db, stationId),
    media: new MediaRepository(db, stationId),
    playlists: new PlaylistRepository(db, stationId),
    schedule: new ScheduleRepository(db, stationId),
    requests: new RequestRepository(db, stationId),
    alerts: new AlertRepository(db, stationId),
    events: new EventRepository(db, stationId),
    history: new HistoryRepository(db, stationId),
    listeners: new ListenerStatsRepository(db, stationId),
    live: new LiveSessionRepository(db, stationId),
    settings: new SettingsRepository(db, stationId),
    backups: new BackupRepository(db),
  };
}
