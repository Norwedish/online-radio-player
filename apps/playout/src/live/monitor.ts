/**
 * Studio monitor: the mix *before* Stereo Tool, streamed to browsers as raw
 * Int16LE stereo PCM over a WebSocket (low latency, no encoder in between).
 *
 * The API authenticates the user and hands the worker a one-time token
 * (`monitor:allow`); the browser connects to `/ws/live/monitor?token=…`.
 * Listeners choose "with mic" (exactly what goes into Stereo Tool) or "without
 * mic" (no delayed copy of your own voice), and full 48 kHz or light 24 kHz.
 */
import type { WebSocket } from "ws";

export interface MonitorOptions {
  /** Include the live mic bus (the exact pre-processing program). */
  mic: boolean;
  rate: 48000 | 24000;
}

/** Tokens must be used within this time. */
const TOKEN_TTL_MS = 30_000;
/** Drop audio for a client whose socket has more than this queued (slow network). */
const MAX_BUFFERED_BYTES = 256 * 1024;
const MAX_CLIENTS = 16;

interface Client {
  ws: WebSocket;
  opts: MonitorOptions;
  dropped: number;
}

/** 48 → 24 kHz by averaging sample pairs (cheap; fine for monitoring). */
export function halfRate(pcm: Buffer): Buffer {
  const frames = Math.floor(pcm.length / 8);
  const out = Buffer.allocUnsafe(frames * 4);
  for (let f = 0; f < frames; f += 1) {
    const i = f * 8;
    out.writeInt16LE((pcm.readInt16LE(i) + pcm.readInt16LE(i + 4)) >> 1, f * 4);
    out.writeInt16LE((pcm.readInt16LE(i + 2) + pcm.readInt16LE(i + 6)) >> 1, f * 4 + 2);
  }
  return out;
}

export class MonitorHub {
  private tokens = new Map<string, { opts: MonitorOptions; expires: number }>();
  private clients = new Set<Client>();

  constructor(private readonly log: (m: string) => void) {}

  /** One-time token for one listener (issued by the API after its permission check). */
  allow(token: string, opts: MonitorOptions): void {
    const now = Date.now();
    for (const [t, v] of this.tokens) if (v.expires < now) this.tokens.delete(t);
    this.tokens.set(token, { opts, expires: now + TOKEN_TTL_MS });
  }

  /** Validates and consumes a token; returns its options. */
  take(token: string | null): MonitorOptions | null {
    if (!token) return null;
    const t = this.tokens.get(token);
    this.tokens.delete(token);
    if (!t || t.expires < Date.now()) return null;
    return t.opts;
  }

  attach(ws: WebSocket, opts: MonitorOptions): void {
    if (this.clients.size >= MAX_CLIENTS) {
      ws.close(1013, "too many monitor listeners");
      return;
    }
    const client: Client = { ws, opts, dropped: 0 };
    this.clients.add(client);
    this.log(`studio monitor connected (${this.clients.size} listening)`);
    ws.send(JSON.stringify({ type: "hello", rate: opts.rate, channels: 2, mic: opts.mic }));
    ws.on("close", () => {
      this.clients.delete(client);
      this.log(`studio monitor disconnected (${this.clients.size} listening)`);
    });
    ws.on("error", () => ws.close());
  }

  get listeners(): number {
    return this.clients.size;
  }

  /** True while a listener wants the mix without the mic (the mixer then renders it). */
  get wantsDry(): boolean {
    for (const c of this.clients) if (!c.opts.mic) return true;
    return false;
  }

  /** Called for every rendered block: `program` is the pre-Stereo Tool output, `dry` the same without mic. */
  feed(program: Buffer, dry: Buffer | null): void {
    if (this.clients.size === 0) return;
    const cache = new Map<string, Buffer>();
    for (const c of this.clients) {
      if (c.ws.readyState !== 1) continue;
      if (c.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        c.dropped += 1;
        continue;
      }
      const key = `${c.opts.mic ? "m" : "d"}${c.opts.rate}`;
      let out = cache.get(key);
      if (!out) {
        const src = c.opts.mic ? program : (dry ?? program);
        out = c.opts.rate === 24000 ? halfRate(src) : src;
        cache.set(key, out);
      }
      c.ws.send(out, { binary: true });
    }
  }

  close(): void {
    for (const c of this.clients) c.ws.close(1001, "worker stopping");
    this.clients.clear();
  }
}
