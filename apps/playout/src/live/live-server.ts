/**
 * Browser studio uplink (ADR 0004: WebSocket PCM). The API authenticates the
 * DJ and hands the worker a one-time token in `live:start`; the browser then
 * connects to `/ws/live?token=…` (proxied by nginx/Vite) and streams Int16LE
 * PCM at 48 kHz. First text message: {"type":"hello","channels":1|2}.
 */
import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { LiveBus } from "../audio/live-bus.js";
import { MonitorHub } from "./monitor.js";

export class LiveServer {
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private token: string | null = null;
  private socket: WebSocket | null = null;
  private stats: NodeJS.Timeout | null = null;
  connected = false;

  /** Listeners of the pre-processing studio monitor. */
  readonly monitor: MonitorHub;

  constructor(
    private readonly bus: LiveBus,
    private readonly log: (m: string) => void,
  ) {
    this.monitor = new MonitorHub(log);
  }

  listen(port: number, host = "127.0.0.1"): Promise<void> {
    this.http = createServer((_req, res) => {
      res.writeHead(426);
      res.end("upgrade required");
    });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    this.http.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const token = url.searchParams.get("token");
      // Studio monitor (pre-Stereo Tool feed to the browser): many listeners, one-time tokens.
      if (url.pathname.endsWith("/live/monitor")) {
        const opts = this.monitor.take(token);
        if (!opts) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        this.wss!.handleUpgrade(req, socket, head, (ws) => this.monitor.attach(ws, opts));
        return;
      }
      if (!url.pathname.endsWith("/live") || !this.token || token !== this.token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws));
    });
    return new Promise((resolve) => this.http!.listen(port, host, () => resolve()));
  }

  /** The bound port (useful after listen(0)). */
  get port(): number {
    const a = this.http?.address();
    return a && typeof a === "object" ? a.port : 0;
  }

  /** Arms the uplink for one session. */
  allow(token: string | null): void {
    this.token = token;
    if (!token) this.disconnect();
  }

  private onSocket(ws: WebSocket): void {
    this.socket?.close(4000, "replaced by a new connection");
    this.socket = ws;
    this.connected = true;
    let channels: 1 | 2 = 1;
    this.log("live studio connected");
    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        try {
          const msg = JSON.parse(String(data)) as { type?: string; channels?: number };
          if (msg.type === "hello") channels = msg.channels === 2 ? 2 : 1;
        } catch {
          // ignore
        }
        return;
      }
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      this.bus.push(buf.length % 2 === 0 ? buf : buf.subarray(0, buf.length - 1), channels);
    });
    ws.on("close", () => {
      if (this.socket === ws) {
        this.socket = null;
        this.connected = false;
        this.log("live studio disconnected");
      }
    });
    if (!this.stats) {
      this.stats = setInterval(() => {
        if (this.socket?.readyState === 1) {
          this.socket.send(
            JSON.stringify({
              type: "stats",
              underruns: this.bus.underruns,
              peak: this.bus.peak,
              receivedFrames: this.bus.receivedFrames,
            }),
          );
        }
      }, 1000);
    }
  }

  disconnect(): void {
    this.socket?.close(1000, "live session ended");
    this.socket = null;
    this.connected = false;
  }

  close(): Promise<void> {
    if (this.stats) clearInterval(this.stats);
    this.disconnect();
    this.monitor.close();
    this.wss?.close();
    return new Promise((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()));
  }
}
