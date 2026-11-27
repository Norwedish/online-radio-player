/**
 * Direct studio monitor: the mix *before* Stereo Tool, as raw PCM over a
 * WebSocket from the playout worker, played by an AudioWorklet jitter buffer
 * (~150 ms instead of the stream's seconds). App-wide like hooks/player.ts:
 * it keeps playing while you move between pages.
 */
import { useSyncExternalStore } from "react";
import { post } from "../lib/api";
import { claimAudio, releaseAudio } from "./audio-focus";

export type MonitorStatus = "idle" | "connecting" | "playing" | "reconnecting" | "error";

export interface MonitorSnapshot {
  status: MonitorStatus;
  /** Include the live mic (you hear yourself delayed) — off by default. */
  mic: boolean;
  rate: 48000 | 24000;
  /** Jitter buffer target. Lower = less delay, more risk of dropouts. */
  latencyMs: number;
  volume: number;
  sinkId: string;
  /** Live stats from the worklet. */
  bufferedMs: number;
  underruns: number;
  peakDb: number;
  error: string | null;
}

const KEY = "radio-monitor";

function loadPrefs(): Partial<MonitorSnapshot> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<MonitorSnapshot>;
  } catch {
    return {};
  }
}

const p = loadPrefs();
let snapshot: MonitorSnapshot = {
  status: "idle",
  mic: p.mic === true,
  rate: p.rate === 24000 ? 24000 : 48000,
  latencyMs: typeof p.latencyMs === "number" ? p.latencyMs : 150,
  volume: typeof p.volume === "number" ? p.volume : 0.8,
  sinkId: typeof p.sinkId === "string" ? p.sinkId : "",
  bufferedMs: 0,
  underruns: 0,
  peakDb: -120,
  error: null,
};
const subscribers = new Set<() => void>();

function set(patch: Partial<MonitorSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  if (["mic", "rate", "latencyMs", "volume", "sinkId"].some((k) => k in patch)) {
    try {
      const { mic, rate, latencyMs, volume, sinkId } = snapshot;
      localStorage.setItem(KEY, JSON.stringify({ mic, rate, latencyMs, volume, sinkId }));
    } catch {
      // storage unavailable: preferences last for this visit
    }
  }
  for (const s of subscribers) s();
}

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

let ctx: SinkContext | null = null;
let node: AudioWorkletNode | null = null;
let gain: GainNode | null = null;
let ws: WebSocket | null = null;
let wanted = false;
let retry: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 1_000;
/** Bumped on every (re)connect so late events from an old socket are ignored. */
let session = 0;

export const canPickOutput =
  typeof AudioContext !== "undefined" &&
  typeof (AudioContext.prototype as SinkContext).setSinkId === "function";

function teardown(): void {
  if (retry) clearTimeout(retry);
  retry = null;
  session += 1;
  const s = ws;
  ws = null;
  s?.close();
  node?.disconnect();
  node = null;
  gain = null;
  const c = ctx;
  ctx = null;
  void c?.close().catch(() => {});
}

async function connect(): Promise<void> {
  teardown();
  const mine = session;
  if (snapshot.status !== "reconnecting") set({ status: "connecting", error: null });
  try {
    const res = await post<{ wsPath: string; rate: number }>("/api/studio/monitor", {
      mic: snapshot.mic,
      rate: snapshot.rate,
    });
    if (mine !== session || !wanted) return;
    const c: SinkContext = new AudioContext({ sampleRate: res.rate, latencyHint: "interactive" });
    ctx = c;
    // Same-origin file: the CSP (script-src 'self') blocks blob: worklets.
    await c.audioWorklet.addModule("/worklets/monitor-player.js");
    if (mine !== session || !wanted) return;
    const n = new AudioWorkletNode(c, "monitor-player", {
      numberOfInputs: 0,
      outputChannelCount: [2],
      processorOptions: { targetMs: snapshot.latencyMs },
    });
    const g = c.createGain();
    g.gain.value = snapshot.volume;
    n.connect(g).connect(c.destination);
    node = n;
    gain = g;
    n.port.onmessage = (e) => {
      const d = e.data as { bufferedMs: number; underruns: number; peak: number };
      set({
        bufferedMs: Math.round(d.bufferedMs),
        underruns: d.underruns,
        peakDb: d.peak > 0 ? Math.round(20 * Math.log10(d.peak)) : -120,
      });
    };
    if (snapshot.sinkId && c.setSinkId) await c.setSinkId(snapshot.sinkId).catch(() => {});
    await c.resume();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const sock = new WebSocket(`${proto}://${location.host}${res.wsPath}`);
    sock.binaryType = "arraybuffer";
    ws = sock;
    sock.onmessage = (e) => {
      if (typeof e.data === "string") return; // hello
      const buf = e.data as ArrayBuffer;
      node?.port.postMessage(buf, [buf]);
      if (snapshot.status !== "playing") {
        retryDelay = 1_000;
        set({ status: "playing", error: null });
      }
    };
    sock.onclose = () => {
      if (mine !== session) return;
      if (wanted) scheduleReconnect();
      else set({ status: "idle" });
    };
  } catch (e) {
    if (mine !== session) return;
    set({ error: e instanceof Error ? e.message : String(e) });
    if (wanted) scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (retry) return;
  set({ status: "reconnecting" });
  retry = setTimeout(() => {
    retry = null;
    if (wanted) void connect();
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 15_000);
}

export function startMonitor(): void {
  claimAudio("monitor", stopMonitor);
  wanted = true;
  retryDelay = 1_000;
  set({ underruns: 0 });
  void connect();
}

export function stopMonitor(): void {
  releaseAudio("monitor");
  wanted = false;
  teardown();
  set({ status: "idle", bufferedMs: 0, peakDb: -120 });
}

export function toggleMonitor(): void {
  if (wanted) stopMonitor();
  else startMonitor();
}

/** Changing mic or quality needs a new feed from the worker. */
export function setMonitorMic(mic: boolean): void {
  set({ mic });
  if (wanted) startMonitor();
}

export function setMonitorRate(rate: 48000 | 24000): void {
  set({ rate });
  if (wanted) startMonitor();
}

export function setMonitorLatency(ms: number): void {
  set({ latencyMs: ms });
  node?.port.postMessage({ type: "target", ms });
}

export function setMonitorVolume(volume: number): void {
  if (gain) gain.gain.value = volume;
  set({ volume });
}

export function setMonitorSink(sinkId: string): void {
  set({ sinkId });
  if (ctx?.setSinkId) void ctx.setSinkId(sinkId).catch(() => set({ sinkId: "" }));
}

export function useMonitor<T>(select: (s: MonitorSnapshot) => T): T {
  return useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    () => select(snapshot),
  );
}

export function monitorActive(status: MonitorStatus): boolean {
  return status !== "idle" && status !== "error";
}
