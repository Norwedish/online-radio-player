/**
 * Live console store: one WebSocket to /ws feeding playout state, meters,
 * listener counts and alert events into a tiny external store (no re-render
 * storms: components subscribe to the slice they need).
 */
import { useSyncExternalStore } from "react";
import type {
  Alert,
  BoundaryEntry,
  LiveStatus,
  Meter,
  NowPlaying,
  PlayoutState,
  QueueItem,
} from "../lib/types";

export interface LiveSnapshot {
  connected: boolean;
  workerConnected: boolean;
  state: PlayoutState | null;
  meter: Meter | null;
  listeners: number;
  lastAlert: Alert | null;
  alertTick: number;
  requestTick: number;
  mediaTick: number;
  planTick: number;
  receivedAt: number;
}

let snapshot: LiveSnapshot = {
  connected: false,
  workerConnected: false,
  state: null,
  meter: null,
  listeners: 0,
  lastAlert: null,
  alertTick: 0,
  requestTick: 0,
  mediaTick: 0,
  planTick: 0,
  receivedAt: 0,
};
const listeners = new Set<() => void>();
let ws: WebSocket | null = null;
let retry = 500;
let started = false;

function set(patch: Partial<LiveSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const l of listeners) l();
}

function patchState(fn: (s: PlayoutState) => PlayoutState): void {
  if (snapshot.state) set({ state: fn(snapshot.state), receivedAt: Date.now() });
}

function onMessage(type: string, data: unknown): void {
  switch (type) {
    case "hello":
      set({ workerConnected: Boolean((data as { workerConnected?: boolean }).workerConnected) });
      break;
    case "playout:state":
      set({ state: data as PlayoutState, receivedAt: Date.now(), workerConnected: true });
      break;
    case "playout:now-playing":
      patchState((s) => ({ ...s, nowPlaying: data as NowPlaying | null }));
      break;
    case "playout:queue":
      patchState((s) => ({ ...s, queue: (data as { items: QueueItem[] }).items }));
      break;
    case "playout:meter":
      set({ meter: data as Meter });
      break;
    case "playout:boundary":
      patchState((s) => ({
        ...s,
        boundaryLog: [data as BoundaryEntry, ...s.boundaryLog].slice(0, 20),
      }));
      break;
    case "live:status":
      patchState((s) => ({ ...s, live: data as LiveStatus }));
      break;
    case "encoders:status":
      patchState((s) => ({
        ...s,
        encoders: (data as { mounts: PlayoutState["encoders"] }).mounts,
      }));
      break;
    case "stereotool:status":
      patchState((s) => ({ ...s, stereotool: data as PlayoutState["stereotool"] }));
      break;
    case "stats:listeners":
      set({ listeners: (data as { total: number }).total });
      break;
    case "worker:status":
      set({ workerConnected: (data as { connected: boolean }).connected });
      break;
    case "alerts:new":
      set({ lastAlert: data as Alert, alertTick: snapshot.alertTick + 1 });
      break;
    case "alerts:ack":
    case "alerts:resolved":
      set({ alertTick: snapshot.alertTick + 1 });
      break;
    case "requests:new":
    case "requests:updated":
      set({ requestTick: snapshot.requestTick + 1 });
      break;
    case "media:imported":
    case "media:scan-done":
      set({ mediaTick: snapshot.mediaTick + 1 });
      break;
    case "plans:changed":
      set({ planTick: snapshot.planTick + 1 });
      break;
  }
}

function connect(): void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${proto}://${location.host}/ws`);
  ws = socket;
  socket.onopen = () => {
    retry = 500;
    set({ connected: true });
  };
  socket.onmessage = (e) => {
    try {
      const msg = JSON.parse(String(e.data)) as { type: string; data: unknown };
      onMessage(msg.type, msg.data);
    } catch {
      // ignore
    }
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    set({ connected: false });
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 10_000);
  };
}

export function startLive(): void {
  if (started) return;
  started = true;
  connect();
  setInterval(() => ws?.readyState === 1 && ws.send(JSON.stringify({ type: "ping" })), 20_000);
}

export function stopLive(): void {
  started = false;
  const s = ws;
  ws = null;
  s?.close();
}

/** Merge a state returned by a control command (instant feedback before the WS event). */
export function applyState(state: PlayoutState | null | undefined): void {
  if (state) set({ state, receivedAt: Date.now() });
}

export function useLive<T>(select: (s: LiveSnapshot) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => select(snapshot),
  );
}
