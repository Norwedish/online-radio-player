/**
 * Priority events (PLAN §6.4.6 / M6.5): scheduled or manual. A higher-priority
 * event preempts automation (or a lower event); a lower-priority event waits
 * until the active one ends. Playlist events play a shuffled slice of their
 * playlist sized to the event length; stingers play one item; live events
 * only reserve the slot for a DJ.
 */
import type { EventRow, Repositories } from "@radio/db";
import type { QueueItem } from "@radio/shared";
import type { EventBus } from "./bus.js";
import { mediaQueueItem } from "./queue-items.js";
import type { WorkerClient } from "../worker-client.js";

export class EventService {
  constructor(
    private readonly repos: Repositories,
    private readonly worker: WorkerClient,
    private readonly bus: EventBus,
    private readonly log: (m: string) => void = () => {},
  ) {}

  itemsFor(ev: EventRow): QueueItem[] {
    if (!ev.playlist_id) return [];
    const pool = this.repos.playlists.pool([ev.playlist_id]).map((p) => p.media);
    if (ev.type === "stinger")
      return pool.slice(0, 1).map((m) => mediaQueueItem(m, { kind: "stinger", source: "event" }));
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    const target = ev.end_at
      ? (Date.parse(ev.end_at) - Math.max(Date.now(), Date.parse(ev.start_at))) / 1000
      : 3600;
    const out: QueueItem[] = [];
    let total = 0;
    for (const m of shuffled) {
      if (total >= target) break;
      out.push(mediaQueueItem(m, { source: "event" }));
      total += m.duration ?? 0;
    }
    return out;
  }

  async start(id: number): Promise<EventRow> {
    const ev = this.repos.events.get(id);
    if (!ev) throw Object.assign(new Error("event not found"), { statusCode: 404 });
    if (ev.type !== "live") {
      const items = this.itemsFor(ev);
      if (items.length === 0)
        throw Object.assign(new Error("event playlist is empty"), { statusCode: 409 });
      await this.worker.send("event:start", {
        id: ev.id,
        title: ev.title,
        priority: Math.min(10, Math.max(1, ev.priority)),
        items,
      });
    }
    const row = this.repos.events.update(id, { status: "active" })!;
    this.bus.publish("playout", "events:updated", row);
    return row;
  }

  async stop(id: number): Promise<EventRow> {
    const ev = this.repos.events.get(id);
    if (!ev) throw Object.assign(new Error("event not found"), { statusCode: 404 });
    if (ev.type !== "live" && this.worker.connected) await this.worker.send("event:stop", { id });
    const row = this.repos.events.update(id, {
      status: "done",
      ended_at: new Date().toISOString(),
    })!;
    this.bus.publish("playout", "events:updated", row);
    return row;
  }

  /** Called every 15 s: start due events by priority, end expired ones. */
  async tick(now = new Date()): Promise<void> {
    const iso = now.toISOString();
    for (const ev of this.repos.events.active()) {
      if (ev.end_at && ev.end_at <= iso)
        await this.stop(ev.id).catch((e) =>
          this.log(`event ${ev.id} stop failed: ${(e as Error).message}`),
        );
    }
    for (const ev of this.repos.events.due(iso)) {
      try {
        await this.start(ev.id);
      } catch (e) {
        // Lower priority than the active event (or worker down): it waits for the next tick.
        this.log(`event ${ev.id} waiting: ${(e as Error).message}`);
      }
    }
  }

  /** Worker reported the event finished on its own (queue exhausted). */
  onWorkerEventEnded(id: number): void {
    const ev = this.repos.events.get(id);
    if (ev && ev.status === "active")
      this.repos.events.update(id, { status: "done", ended_at: new Date().toISOString() });
  }
}
