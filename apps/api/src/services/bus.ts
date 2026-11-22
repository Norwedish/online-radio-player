/** In-process pub/sub feeding the WebSocket hub (PLAN §6.8). */
import { EventEmitter } from "node:events";

export type Channel = "playout" | "live" | "alerts" | "requests" | "stats" | "media";

export interface BusMessage {
  channel: Channel;
  type: string;
  data: unknown;
}

export class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(1000);
  }

  publish(channel: Channel, type: string, data: unknown): void {
    this.emit("message", { channel, type, data } satisfies BusMessage);
  }

  subscribe(handler: (m: BusMessage) => void): () => void {
    this.on("message", handler);
    return () => this.off("message", handler);
  }
}
