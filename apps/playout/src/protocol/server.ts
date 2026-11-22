/**
 * Worker protocol server (PLAN §6.4.8 / M4.7): newline-delimited JSON over a
 * Unix socket (production) or 127.0.0.1 TCP (Windows dev). Commands are
 * validated with the shared Zod schemas; responses echo the request id;
 * events and 5 s heartbeats are broadcast to every connected client.
 */
import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import {
  PROTOCOL_VERSION,
  envelopeSchema,
  parseCommand,
  type CommandType,
  type WorkerEventType,
} from "@radio/shared";

export type CommandHandler = (type: CommandType, payload: unknown) => Promise<unknown> | unknown;

const MAX_LINE = 1024 * 1024;

export class ProtocolServer {
  private server: Server | null = null;
  private readonly clients = new Set<Socket>();
  private heartbeat: NodeJS.Timeout | null = null;
  /** Commands are serialized so conflicting operations never interleave (M6.3). */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly handler: CommandHandler,
    private readonly opts: {
      token?: string;
      log?: (m: string) => void;
      heartbeatMs?: number;
      hello?: () => unknown;
    } = {},
  ) {}

  listen(endpoint: { socket: string } | { port: number; host?: string }): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.onConnection(socket));
      server.on("error", reject);
      if ("socket" in endpoint) {
        mkdirSync(dirname(endpoint.socket), { recursive: true });
        if (existsSync(endpoint.socket)) unlinkSync(endpoint.socket);
        server.listen(endpoint.socket, () => {
          try {
            chmodSync(endpoint.socket, 0o660);
          } catch {
            // best effort
          }
          resolve();
        });
      } else {
        server.listen(endpoint.port, endpoint.host ?? "127.0.0.1", () => resolve());
      }
      this.server = server;
      this.heartbeat = setInterval(
        () => this.broadcast("heartbeat", { ts: Date.now() }),
        this.opts.heartbeatMs ?? 5000,
      );
    });
  }

  address(): string {
    const a = this.server?.address();
    return typeof a === "string" ? a : a ? `${a.address}:${a.port}` : "";
  }

  get port(): number {
    const a = this.server?.address();
    return a && typeof a !== "string" ? a.port : 0;
  }

  private onConnection(socket: Socket): void {
    let authed = !this.opts.token;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.setNoDelay(true);
    const write = (obj: unknown) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(obj)}\n`);
    };
    if (authed) {
      this.clients.add(socket);
      write({
        v: PROTOCOL_VERSION,
        type: "event",
        event: "hello",
        payload: this.opts.hello?.() ?? {},
        ts: Date.now(),
      });
    }
    socket.on("data", (data: string) => {
      buffer += data;
      if (buffer.length > MAX_LINE) {
        write({ v: PROTOCOL_VERSION, type: "error", error: "line too long" });
        socket.destroy();
        return;
      }
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          write({ v: PROTOCOL_VERSION, type: "error", error: "malformed JSON" });
          continue;
        }
        const env = envelopeSchema.safeParse(msg);
        if (!env.success) {
          write({
            v: PROTOCOL_VERSION,
            type: "error",
            error: `invalid envelope: ${env.error.issues[0]?.message ?? ""}`,
          });
          continue;
        }
        const { id, type, payload } = env.data;
        if (!authed) {
          if (
            type === "auth" &&
            (payload as { token?: string } | undefined)?.token === this.opts.token
          ) {
            authed = true;
            this.clients.add(socket);
            write({
              v: PROTOCOL_VERSION,
              id,
              type: "response",
              ok: true,
              payload: this.opts.hello?.() ?? {},
            });
          } else {
            write({ v: PROTOCOL_VERSION, id, type: "response", ok: false, error: "unauthorized" });
            socket.destroy();
          }
          continue;
        }
        const parsed = parseCommand(type, payload);
        if (!parsed.ok) {
          write({ v: PROTOCOL_VERSION, id, type: "response", ok: false, error: parsed.error });
          continue;
        }
        this.chain = this.chain
          .then(() => this.handler(parsed.type, parsed.payload))
          .then(
            (result) =>
              write({
                v: PROTOCOL_VERSION,
                id,
                type: "response",
                ok: true,
                payload: result ?? null,
                ts: Date.now(),
              }),
            (error: Error) =>
              write({
                v: PROTOCOL_VERSION,
                id,
                type: "response",
                ok: false,
                error: error.message,
                ts: Date.now(),
              }),
          );
      }
    });
    socket.on("close", () => this.clients.delete(socket));
    socket.on("error", () => this.clients.delete(socket));
  }

  broadcast(event: WorkerEventType, payload: unknown): void {
    const line = `${JSON.stringify({ v: PROTOCOL_VERSION, type: "event", event, payload, ts: Date.now() })}\n`;
    for (const c of this.clients) if (!c.destroyed) c.write(line);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.clients) c.destroy();
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
