/**
 * radio-api side of the worker protocol (PLAN §6.4.8): NDJSON client with
 * request ids, timeouts, exponential-backoff reconnect and a heartbeat watchdog.
 * Worker events are re-emitted as `event` (type, payload).
 */
import { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { PROTOCOL_VERSION, type CommandType, type PlayoutState } from "@radio/shared";

export class WorkerUnavailableError extends Error {
  constructor(message = "playout worker is not connected") {
    super(message);
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class WorkerClient extends EventEmitter {
  private socket: Socket | null = null;
  private buffer = "";
  private pending = new Map<string, Pending>();
  private backoff = 500;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private closed = false;
  connected = false;
  lastHeartbeat = 0;
  lastState: PlayoutState | null = null;

  constructor(
    private readonly endpoint: { socket: string } | { port: number; host?: string },
    private readonly opts: { token?: string; timeoutMs?: number; log?: (m: string) => void } = {},
  ) {
    super();
    this.setMaxListeners(100);
  }

  start(): void {
    this.closed = false;
    this.connect();
    this.watchdog = setInterval(() => {
      if (this.connected && Date.now() - this.lastHeartbeat > 15_000) {
        this.opts.log?.("worker heartbeat lost, reconnecting");
        this.socket?.destroy();
      }
    }, 5000);
  }

  private connect(): void {
    const sock =
      "socket" in this.endpoint
        ? connect(this.endpoint.socket)
        : connect(this.endpoint.port, this.endpoint.host ?? "127.0.0.1");
    this.socket = sock;
    sock.setEncoding("utf8");
    sock.setNoDelay(true);
    sock.on("connect", () => {
      this.connected = true;
      this.backoff = 500;
      this.lastHeartbeat = Date.now();
      if (this.opts.token)
        sock.write(
          `${JSON.stringify({ v: PROTOCOL_VERSION, id: "auth", type: "auth", payload: { token: this.opts.token } })}\n`,
        );
      this.emit("connected");
      this.opts.log?.("connected to playout worker");
    });
    sock.on("data", (d: string) => this.onData(d));
    const onClose = () => {
      if (this.socket !== sock) return;
      const was = this.connected;
      this.connected = false;
      this.socket = null;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new WorkerUnavailableError("playout worker disconnected"));
        this.pending.delete(id);
      }
      if (was) this.emit("disconnected");
      if (!this.closed) {
        this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 10_000);
      }
    };
    sock.on("close", onClose);
    sock.on("error", () => {
      /* close follows */
    });
  }

  private onData(data: string): void {
    this.buffer += data;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: {
        id?: string;
        type: string;
        ok?: boolean;
        payload?: unknown;
        error?: string;
        event?: string;
      };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === "response" && msg.id) {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) {
          if (msg.payload && typeof msg.payload === "object" && "mode" in (msg.payload as object))
            this.lastState = msg.payload as PlayoutState;
          p.resolve(msg.payload);
        } else p.reject(new Error(msg.error ?? "worker error"));
      } else if (msg.type === "event" && msg.event) {
        this.lastHeartbeat = Date.now();
        if (msg.event === "state") this.lastState = msg.payload as PlayoutState;
        if (msg.event === "hello")
          this.lastState = (msg.payload as { state?: PlayoutState }).state ?? this.lastState;
        this.emit("event", msg.event, msg.payload);
      }
    }
  }

  send<T = PlayoutState>(
    type: CommandType,
    payload: unknown = {},
    timeoutMs = this.opts.timeoutMs ?? 5000,
  ): Promise<T> {
    const sock = this.socket;
    if (!sock || !this.connected) return Promise.reject(new WorkerUnavailableError());
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`worker command ${type} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      sock.write(`${JSON.stringify({ v: PROTOCOL_VERSION, id, type, payload, ts: Date.now() })}\n`);
    });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
  }
}
