/**
 * Compact monitor for the console header: the processed listener stream
 * (hooks/player.ts) or the direct studio feed before Stereo Tool
 * (hooks/monitor.ts). Both keep playing while you switch pages.
 */
import { useEffect, useRef, useState } from "react";
import { Ear, Headphones, Loader2, Square, Volume2, VolumeX } from "lucide-react";
import {
  isActive,
  loadStreams,
  playStream,
  setMount,
  setMuted,
  setVolume,
  togglePlay,
  usePlayer,
} from "../hooks/player";
import {
  monitorActive,
  setMonitorVolume,
  startMonitor,
  toggleMonitor,
  useMonitor,
} from "../hooks/monitor";
import { useLive } from "../hooks/live";
import { cx } from "./ui";

const STATUS_TEXT: Record<string, string> = {
  connecting: "Connecting…",
  buffering: "Buffering…",
  reconnecting: "Reconnecting…",
  error: "Stream unavailable",
};

const SOURCE_KEY = "radio-monitor-source";
/** Value of the "direct" entry in the stream list. */
const DIRECT = "__direct";

export function MiniPlayer() {
  const streamStatus = usePlayer((s) => s.status);
  const mounts = usePlayer((s) => s.mounts);
  const mount = usePlayer((s) => s.mount);
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const monStatus = useMonitor((s) => s.status);
  const monVolume = useMonitor((s) => s.volume);
  const [direct, setDirect] = useState(() => localStorage.getItem(SOURCE_KEY) === "direct");
  const lastMonVolume = useRef(monVolume || 0.8);
  // Automation's track, or in manual mode the studio player that is on air.
  const np = useLive(
    (s) =>
      s.state?.nowPlaying ??
      s.state?.studio?.players.find((p) => p.status === "playing")?.item ??
      null,
  );
  // Follow whichever source is actually playing (the Studio panel can start the monitor too).
  const monOn = monitorActive(monStatus);
  const showDirect = monOn || (direct && !isActive(streamStatus));
  const status = showDirect ? monStatus : streamStatus;
  const active = showDirect ? monOn : isActive(streamStatus);
  const busy = status === "connecting" || status === "reconnecting";

  useEffect(() => {
    void loadStreams();
  }, []);

  const chooseSource = (value: string) => {
    const toDirect = value === DIRECT;
    setDirect(toDirect);
    localStorage.setItem(SOURCE_KEY, toDirect ? "direct" : "stream");
    // Switching while listening hands over directly (audio focus stops the other source).
    if (toDirect) {
      if (active) startMonitor();
      return;
    }
    setMount(value);
    if (active && monOn) playStream();
  };

  const label =
    STATUS_TEXT[status] ??
    (showDirect && active
      ? `Direct · ${np ? `${np.artist ? `${np.artist} – ` : ""}${np.title}` : "studio mix"}`
      : np
        ? `${np.artist ? `${np.artist} – ` : ""}${np.title}`
        : active
          ? "On air"
          : "Monitor stream");

  const vol = showDirect ? monVolume : muted ? 0 : volume;
  const isMuted = showDirect ? monVolume === 0 : muted || volume === 0;

  return (
    <div
      className={cx(
        "flex h-9 min-w-0 items-center gap-2 rounded-md border pl-1 pr-2",
        active
          ? showDirect
            ? "border-signal/60 bg-signal/10"
            : "border-tally/60 bg-tally/10"
          : "border-line bg-panel",
      )}
      role="group"
      aria-label="Stream monitor"
    >
      <button
        type="button"
        onClick={() => {
          if (showDirect) toggleMonitor();
          else togglePlay();
        }}
        aria-label={
          active
            ? showDirect
              ? "Stop direct monitor"
              : "Stop stream"
            : showDirect
              ? "Listen to the direct studio feed"
              : "Listen to the stream"
        }
        title={showDirect ? "Direct studio feed (before Stereo Tool)" : "Processed listener stream"}
        className={cx(
          "flex size-7 shrink-0 items-center justify-center rounded",
          active
            ? showDirect
              ? "bg-signal text-black"
              : "bg-tally text-black"
            : "text-muted hover:bg-panel-2 hover:text-legend",
        )}
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" />
        ) : active ? (
          <Square className="size-3.5" fill="currentColor" />
        ) : showDirect ? (
          <Ear className="size-4" />
        ) : (
          <Headphones className="size-4" />
        )}
      </button>
      <span
        className={cx(
          "hidden max-w-56 truncate text-sm xl:inline",
          status === "error" ? "text-clip" : active ? "text-legend" : "text-muted",
        )}
        title={label}
        aria-live="polite"
      >
        {label}
      </span>
      <button
        type="button"
        onClick={() => {
          if (!showDirect) return setMuted(!muted);
          if (monVolume > 0) {
            lastMonVolume.current = monVolume;
            setMonitorVolume(0);
          } else setMonitorVolume(lastMonVolume.current || 0.8);
        }}
        aria-label={isMuted ? "Unmute" : "Mute"}
        className="hidden text-muted hover:text-legend sm:block"
      >
        {isMuted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={Math.min(1, vol)}
        onChange={(e) =>
          showDirect ? setMonitorVolume(Number(e.target.value)) : setVolume(Number(e.target.value))
        }
        aria-label="Stream volume"
        className={cx(
          "hidden w-20 sm:block",
          showDirect ? "accent-[var(--color-signal)]" : "accent-[var(--color-tally)]",
        )}
      />
      <select
        value={showDirect ? DIRECT : mount}
        onChange={(e) => chooseSource(e.target.value)}
        aria-label="Stream"
        className="hidden h-7 rounded border border-line-strong bg-transparent px-1 text-xs text-muted md:block"
      >
        <option value={DIRECT} className="bg-desk">
          Direct (no processing)
        </option>
        {mounts.map((m) => (
          <option key={m.mount} value={m.mount} className="bg-desk">
            {m.codec.toUpperCase()} {m.bitrate}
          </option>
        ))}
      </select>
    </div>
  );
}
