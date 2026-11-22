/**
 * Worker → API persistence and fan-out (ADR 0005: the API is the only DB
 * writer). Track starts become play_history rows, boundary decisions become
 * boundary_events, worker alerts go through the alert service, requests are
 * marked played, Icecast metadata is updated, and everything is published to
 * the WebSocket channels.
 */
import type { Repositories } from "@radio/db";
import {
  secret,
  type BoundaryLogEntry,
  type QueueItem,
  type RuntimeConfig,
  type WorkerAlert,
} from "@radio/shared";
import { parseIcecastStatus } from "@radio/shared";
import type { AlertService } from "./alerts.js";
import type { EventBus } from "./bus.js";
import type { EventService } from "./events.js";
import type { Metrics } from "./metrics.js";
import type { RequestService } from "./requests.js";
import type { WorkerClient } from "../worker-client.js";

const SOURCE_MAP: Record<string, "automation" | "live" | "event" | "request" | "manual"> = {
  automation: "automation",
  request: "request",
  manual: "manual",
  event: "event",
  live: "live",
};

export class StationSync {
  private openHistory = new Map<string, number>();
  private currentListeners = 0;
  private statsTimer: NodeJS.Timeout | null = null;
  lastIcecastPoll: { ok: boolean; at: string; error?: string } | null = null;

  constructor(
    private readonly repos: Repositories,
    private readonly config: RuntimeConfig,
    private readonly worker: WorkerClient,
    private readonly bus: EventBus,
    private readonly alerts: AlertService,
    private readonly requests: RequestService,
    private readonly events: EventService,
    private readonly metrics: Metrics,
    private readonly log: (m: string) => void = () => {},
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  start(): void {
    this.worker.on("event", (type: string, payload: unknown) => this.onWorkerEvent(type, payload));
    this.worker.on("connected", () => {
      this.bus.publish("playout", "worker:status", { connected: true });
      this.alerts.resolve("worker_down");
    });
    this.worker.on("disconnected", () => {
      this.bus.publish("playout", "worker:status", { connected: false });
      void this.alerts.raise({
        type: "worker_down",
        severity: "critical",
        message: "Playout worker disconnected",
      });
    });
    const every = this.config.metrics.listenerSampleSeconds * 1000;
    this.statsTimer = setInterval(() => void this.pollIcecast(), every);
    void this.pollIcecast();
  }

  stop(): void {
    if (this.statsTimer) clearInterval(this.statsTimer);
  }

  onWorkerEvent(type: string, payload: unknown): void {
    try {
      switch (type) {
        case "track_started": {
          const { item, startedAt } = payload as { item: QueueItem; startedAt: string };
          if (item.mediaId !== null && this.repos.media.get(item.mediaId)) {
            const id = this.repos.history.start({
              mediaId: item.mediaId,
              planId: item.planId,
              startedAt,
              source: SOURCE_MAP[item.source] ?? "automation",
              listeners: this.currentListeners,
            });
            this.openHistory.set(item.uid, id);
          }
          if (item.requestId) this.requests.markPlayed(item.requestId);
          this.metrics.inc("radio_tracks_started_total", { kind: item.kind });
          void this.updateIcecastMetadata(item);
          this.bus.publish("playout", "playout:track-started", payload);
          break;
        }
        case "track_ended": {
          const { item, endedAt } = payload as { item: QueueItem; endedAt: string };
          const id = this.openHistory.get(item.uid);
          if (id) {
            this.repos.history.end(id, endedAt, this.currentListeners);
            this.openHistory.delete(item.uid);
          }
          break;
        }
        case "boundary": {
          const b = payload as BoundaryLogEntry;
          if (b.planId && this.repos.schedule.planById(b.planId)) {
            this.repos.schedule.logBoundary({
              planId: b.planId,
              occurredAt: new Date(b.at).toISOString(),
              boundaryAt: new Date(b.boundaryAt).toISOString(),
              action: b.action,
              deviationMs: b.deviationMs,
              details: b.details,
            });
          }
          this.metrics.inc("radio_boundary_events_total", { action: b.action });
          this.metrics.set("radio_boundary_last_deviation_ms", b.deviationMs);
          this.bus.publish("playout", "playout:boundary", b);
          break;
        }
        case "alert": {
          const a = payload as WorkerAlert;
          if (a.type === "event_ended" && typeof a.details?.eventId === "number")
            this.events.onWorkerEventEnded(a.details.eventId);
          if (a.type === "icecast_source_restored") this.alerts.resolve("icecast_source_loss");
          void this.alerts.raise(a);
          break;
        }
        case "state":
          this.bus.publish("playout", "playout:state", payload);
          break;
        case "now_playing":
          this.bus.publish("playout", "playout:now-playing", payload);
          break;
        case "queue":
          this.bus.publish("playout", "playout:queue", payload);
          break;
        case "meter":
          this.bus.publish("playout", "playout:meter", payload);
          break;
        case "live:status":
          this.bus.publish("live", "live:status", payload);
          break;
        case "encoder:status": {
          const mounts = (
            payload as { mounts: { mount: string; running: boolean; restarts: number }[] }
          ).mounts;
          for (const m of mounts) {
            this.metrics.set("radio_encoder_up", m.running ? 1 : 0, { mount: m.mount });
            this.metrics.set("radio_encoder_restarts", m.restarts, { mount: m.mount });
          }
          this.bus.publish("playout", "encoders:status", payload);
          break;
        }
        case "stereotool:status": {
          const st = payload as { running: boolean; bypassed: boolean };
          this.metrics.set("radio_stereotool_up", st.running ? 1 : 0);
          this.metrics.set("radio_stereotool_bypassed", st.bypassed ? 1 : 0);
          this.bus.publish("playout", "stereotool:status", payload);
          break;
        }
        case "icecast:status":
          this.bus.publish("playout", "icecast:status", payload);
          break;
      }
    } catch (e) {
      this.log(`worker event ${type} failed: ${(e as Error).message}`);
    }
  }

  private icecastBase(): string {
    return `http://${this.config.icecast.host}:${this.config.icecast.port}`;
  }

  /** Listener sampling (M12.3) + Prometheus gauges. */
  async pollIcecast(): Promise<{ mount: string; listeners: number }[]> {
    try {
      const res = await this.fetchImpl(`${this.icecastBase()}/status-json.xsl`, {
        signal: AbortSignal.timeout(4000),
      });
      const status = parseIcecastStatus(await res.json());
      const known = new Set(this.config.icecast.mounts.map((m) => m.name));
      const samples = status
        .filter((s) => known.has(s.mount))
        .map((s) => ({ mount: s.mount, listeners: s.listeners }));
      this.currentListeners = samples.reduce((n, s) => n + s.listeners, 0);
      if (samples.length) this.repos.listeners.record(new Date().toISOString(), samples);
      this.metrics.resetGauge("radio_listeners");
      for (const s of samples) this.metrics.set("radio_listeners", s.listeners, { mount: s.mount });
      this.metrics.set("radio_listeners_total", this.currentListeners);
      this.bus.publish("stats", "stats:listeners", {
        total: this.currentListeners,
        mounts: samples,
      });
      this.lastIcecastPoll = { ok: true, at: new Date().toISOString() };
      return samples;
    } catch (e) {
      this.lastIcecastPoll = {
        ok: false,
        at: new Date().toISOString(),
        error: (e as Error).message,
      };
      return [];
    }
  }

  get listeners(): number {
    return this.currentListeners;
  }

  /** ICY metadata for MP3/AAC mounts via the Icecast admin API. */
  private async updateIcecastMetadata(item: QueueItem): Promise<void> {
    const pw = secret(this.config.icecast.adminPasswordEnv);
    if (!pw || item.kind === "news") return;
    const song = [item.artist, item.title].filter(Boolean).join(" - ") || this.config.station.name;
    const auth = Buffer.from(`${this.config.icecast.adminUser}:${pw}`).toString("base64");
    for (const m of this.config.icecast.mounts.filter((x) => x.codec !== "opus")) {
      try {
        await this.fetchImpl(
          `${this.icecastBase()}/admin/metadata?mount=/${m.name}&mode=updinfo&song=${encodeURIComponent(song)}`,
          { headers: { authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(3000) },
        );
      } catch {
        // metadata is best effort
      }
    }
  }
}
