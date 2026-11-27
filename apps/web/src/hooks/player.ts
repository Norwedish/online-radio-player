/**
 * App-wide stream player. The <audio> element lives outside the React tree, so
 * playback keeps going while you move between pages (/admin/*, /listen); every
 * player UI is just a view on this one store. Same tiny external-store pattern
 * as hooks/live.ts.
 */
import { useSyncExternalStore } from "react";
import { get } from "../lib/api";
import { claimAudio, releaseAudio } from "./audio-focus";

export interface StreamMount {
  mount: string;
  url: string;
  codec: string;
  bitrate: string;
  contentType: string;
  primary: boolean;
}

export type PlayerStatus =
  "idle" | "connecting" | "playing" | "buffering" | "reconnecting" | "error";

export interface PlayerSnapshot {
  status: PlayerStatus;
  mounts: StreamMount[];
  hls: string | null;
  mount: string;
  volume: number;
  muted: boolean;
}

const STORE_KEY = "radio-player";

function loadPrefs(): Partial<Pick<PlayerSnapshot, "mount" | "volume" | "muted">> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as Partial<PlayerSnapshot>;
  } catch {
    return {};
  }
}

const prefs = loadPrefs();
let snapshot: PlayerSnapshot = {
  status: "idle",
  mounts: [],
  hls: null,
  mount: prefs.mount ?? "",
  volume: typeof prefs.volume === "number" ? prefs.volume : 0.8,
  muted: prefs.muted === true,
};
const subscribers = new Set<() => void>();

function set(patch: Partial<PlayerSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  if ("mount" in patch || "volume" in patch || "muted" in patch) {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({ mount: snapshot.mount, volume: snapshot.volume, muted: snapshot.muted }),
      );
    } catch {
      // storage unavailable (private mode): preferences last for this visit only
    }
  }
  for (const s of subscribers) s();
}

/* ── Audio element ─────────────────────────────────────────────────────── */

let audio: HTMLAudioElement | null = null;
let hls: { destroy(): void } | null = null;
/** True while the user wants sound: drives automatic reconnects. */
let wanted = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 1_000;

function el(): HTMLAudioElement {
  if (audio) return audio;
  const a = new Audio();
  a.preload = "none";
  a.volume = snapshot.volume;
  a.muted = snapshot.muted;
  // In the document (outside React's #root) so devtools/tests can find it; React never unmounts it.
  a.hidden = true;
  document.body.appendChild(a);
  a.addEventListener("playing", () => {
    retryDelay = 1_000;
    set({ status: "playing" });
  });
  a.addEventListener("waiting", () => {
    if (snapshot.status === "playing") set({ status: "buffering" });
  });
  // A live stream only "ends" or errors when the connection drops (Icecast or
  // playout restart, network blip): reconnect while the user still wants sound.
  const dropped = () => {
    if (wanted) scheduleReconnect();
  };
  a.addEventListener("error", dropped);
  a.addEventListener("ended", dropped);
  audio = a;
  return a;
}

function detach(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  hls?.destroy();
  hls = null;
  const a = audio;
  if (a) {
    a.pause();
    a.removeAttribute("src");
    a.load();
  }
}

function scheduleReconnect(): void {
  if (retryTimer) return;
  set({ status: "reconnecting" });
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (wanted) void connect();
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 15_000);
}

async function playHls(a: HTMLAudioElement): Promise<boolean> {
  if (!snapshot.hls) return false;
  if (a.canPlayType("application/vnd.apple.mpegurl")) {
    a.src = snapshot.hls;
    await a.play();
    return true;
  }
  const { default: Hls } = await import("hls.js");
  if (!Hls.isSupported()) return false;
  const h = new Hls({ liveSyncDurationCount: 2 });
  h.loadSource(snapshot.hls);
  h.attachMedia(a);
  hls = h;
  await a.play();
  return true;
}

async function connect(): Promise<void> {
  await loadStreams();
  const m = snapshot.mounts.find((x) => x.mount === snapshot.mount) ?? snapshot.mounts[0];
  if (!m) {
    set({ status: "error" });
    return;
  }
  const a = el();
  detach();
  if (snapshot.status !== "reconnecting") set({ status: "connecting" });
  try {
    // Cache-bust so a reconnect never replays a stale buffer.
    a.src = `${m.url}${m.url.includes("?") ? "&" : "?"}t=${Date.now()}`;
    await a.play();
  } catch (e) {
    if (!wanted) return;
    // Autoplay blocked: needs a click, retrying would not help.
    if (e instanceof DOMException && e.name === "NotAllowedError") {
      wanted = false;
      set({ status: "idle" });
      return;
    }
    try {
      if (await playHls(a)) return;
    } catch {
      // fall through to a reconnect
    }
    if (wanted) scheduleReconnect();
  }
}

/* ── Public API ───────────────────────────────────────────────────────── */

let streamsLoaded: Promise<void> | null = null;

/** Fetch the public stream list once (mounts + optional HLS) and pick a default mount. */
export function loadStreams(): Promise<void> {
  streamsLoaded ??= get<{ streams: { mounts: StreamMount[]; hls: string | null } }>(
    "/api/public/now-playing",
  )
    .then(({ streams }) => {
      const mounts = streams.mounts;
      const saveData = (navigator as { connection?: { saveData?: boolean } }).connection?.saveData;
      const mount = mounts.some((m) => m.mount === snapshot.mount)
        ? snapshot.mount
        : ((saveData ? mounts.find((m) => m.mount.includes("mobile")) : undefined)?.mount ??
          mounts.find((m) => m.primary)?.mount ??
          mounts[0]?.mount ??
          "");
      set({ mounts, hls: streams.hls, mount });
    })
    .catch(() => {
      streamsLoaded = null; // try again on the next play
    });
  return streamsLoaded;
}

export function playStream(): void {
  claimAudio("stream", stopStream);
  wanted = true;
  retryDelay = 1_000;
  void connect();
}

export function stopStream(): void {
  releaseAudio("stream");
  wanted = false;
  detach();
  set({ status: "idle" });
}

export function togglePlay(): void {
  if (wanted) stopStream();
  else playStream();
}

export function setMount(mount: string): void {
  set({ mount });
  if (wanted) playStream();
}

export function setVolume(volume: number): void {
  if (audio) audio.volume = volume;
  set({ volume, muted: volume === 0 ? snapshot.muted : false });
  if (audio) audio.muted = snapshot.muted;
}

export function setMuted(muted: boolean): void {
  if (audio) audio.muted = muted;
  set({ muted });
}

export function usePlayer<T>(select: (s: PlayerSnapshot) => T): T {
  return useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    () => select(snapshot),
  );
}

/** Playing or about to (connecting/buffering/reconnecting): the button shows "stop". */
export function isActive(status: PlayerStatus): boolean {
  return status !== "idle" && status !== "error";
}
