/**
 * Pre-listen (cue) player: plays a library track in this browser only — the
 * stream is not affected. Respects the track's cue-in/cue-out, can route to a
 * separate output (headphones) where the browser supports it, and sends the
 * track to Player A/B starting at the position you found. Library tracks and
 * queue items can be dropped on it; its own track can be dragged onto a player
 * (starting at the position you found) or into the queue.
 */
import { useEffect, useRef, useState } from "react";
import { GripVertical, Headphones, Pause, Play, Search, Square } from "lucide-react";
import { trackLine } from "../../lib/format";
import type { Media, QueueItem, StudioPlayerId } from "../../lib/types";
import { command } from "../console";
import { Button, Panel, Select, cx } from "../ui";
import { droppedMedia, droppedQueueUid, isMediaDrag, isQueueDrag, startMediaDrag } from "./drag";
import { tenths } from "./PlayerDeck";

export interface CueTrack {
  mediaId: number;
  title: string;
  artist: string;
  /** File time where the track starts. */
  cueIn: number;
  /** Playable length after cue-in. */
  duration: number;
  intro: number | null;
  outro: number | null;
}

export function cueFromMedia(m: Media): CueTrack {
  const cueIn = m.cue_in ?? 0;
  const end = m.cue_out && m.cue_out > 0 ? m.cue_out : (m.duration ?? 0);
  const rel = (v: number | null) => (v !== null && v > cueIn ? v - cueIn : null);
  return {
    mediaId: m.id,
    title: m.title ?? "",
    artist: m.artist ?? "",
    cueIn,
    duration: Math.max(0, end - cueIn),
    intro: rel(m.intro_end),
    outro: rel(m.outro_start),
  };
}

export function cueFromItem(i: QueueItem): CueTrack | null {
  if (!i.mediaId) return null;
  return {
    mediaId: i.mediaId,
    title: i.title,
    artist: i.artist,
    cueIn: i.cueIn ?? 0,
    duration: i.duration,
    intro: i.intro ?? null,
    outro: i.outro ?? null,
  };
}

type SinkAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
const SINK_KEY = "studio-cue-output";

export function CuePlayer({
  track,
  onFind,
  onDropMedia,
  onDropQueueItem,
  controls,
  loadable,
}: {
  track: CueTrack | null;
  /** Open the library drawer to choose a track to pre-listen. */
  onFind: () => void;
  /** A library track was dropped here. */
  onDropMedia: (mediaId: number) => void;
  /** A queue item was dropped here. */
  onDropQueueItem: (uid: string) => void;
  controls: boolean;
  /** Players that can take a track right now (not on air). */
  loadable: Record<StudioPlayerId, boolean>;
}) {
  const ref = useRef<SinkAudio | null>(null);
  const [dropOver, setDropOver] = useState(false);
  // Our own track dragged out (to a player or the queue) must not reload it here.
  const draggingOut = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [sink, setSink] = useState(() => localStorage.getItem(SINK_KEY) ?? "");
  const canPickOutput = typeof (HTMLMediaElement.prototype as SinkAudio).setSinkId === "function";

  // New track: load it at its cue-in, paused.
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    a.pause();
    setPlaying(false);
    setPos(0);
    if (!track) {
      a.removeAttribute("src");
      a.load();
      return;
    }
    a.src = `/api/media/${track.mediaId}/preview`;
    const start = () => {
      a.currentTime = track.cueIn;
    };
    a.addEventListener("loadedmetadata", start, { once: true });
    a.load();
  }, [track]);

  useEffect(() => {
    if (ref.current) ref.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    if (!canPickOutput) return;
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((d) => setOutputs(d.filter((x) => x.kind === "audiooutput")));
  }, [canPickOutput]);

  useEffect(() => {
    const a = ref.current;
    if (a?.setSinkId) void a.setSinkId(sink).catch(() => setSink(""));
  }, [sink]);

  const onTime = () => {
    const a = ref.current;
    if (!a || !track) return;
    const p = a.currentTime - track.cueIn;
    // Honour cue-out: the preview ends where the on-air track would.
    if (p >= track.duration) {
      a.pause();
      setPlaying(false);
      setPos(track.duration);
      return;
    }
    setPos(Math.max(0, p));
  };

  const toggle = () => {
    const a = ref.current;
    if (!a || !track) return;
    if (playing) {
      a.pause();
      setPlaying(false);
    } else {
      if (pos >= track.duration) a.currentTime = track.cueIn;
      void a.play().then(() => setPlaying(true));
    }
  };
  const seek = (p: number) => {
    const a = ref.current;
    if (!a || !track) return;
    a.currentTime = track.cueIn + p;
    setPos(p);
  };
  const stop = () => {
    ref.current?.pause();
    setPlaying(false);
    seek(0);
  };
  const sendTo = (player: StudioPlayerId) =>
    track &&
    command(
      `/api/studio/players/${player}/load`,
      { mediaId: track.mediaId, cuePoint: Math.round(pos * 10) / 10 },
      "POST",
      `Loaded into ${player}${pos > 0.5 ? ` at ${tenths(pos)}` : ""}`,
    );

  return (
    <div
      className="relative"
      onDragOver={(e) => {
        if (draggingOut.current || (!isMediaDrag(e) && !isQueueDrag(e))) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (!dropOver) setDropOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOver(false);
      }}
      onDrop={(e) => {
        setDropOver(false);
        if (draggingOut.current) return;
        const media = droppedMedia(e);
        const uid = media ? null : droppedQueueUid(e);
        if (!media && !uid) return;
        e.preventDefault();
        if (media) onDropMedia(media.mediaId);
        else if (uid) onDropQueueItem(uid);
      }}
    >
      {dropOver ? (
        <div
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-info bg-desk/80 font-display text-xl font-semibold text-info"
          aria-hidden
        >
          Drop to pre-listen
        </div>
      ) : null}
      <Panel
        title={
          <span className="inline-flex items-center gap-2">
            <Headphones className="size-4 text-info" /> Pre-listen
          </span>
        }
        actions={
          <Button size="sm" tone="ghost" onClick={onFind}>
            <Search className="size-4" /> Find
          </Button>
        }
      >
        <audio
          ref={ref}
          preload="metadata"
          onTimeUpdate={onTime}
          onEnded={() => setPlaying(false)}
        />
        {track ? (
          <>
            <p
              draggable
              onDragStart={(e) => {
                draggingOut.current = true;
                startMediaDrag(e, { id: track.mediaId, title: track.title }, pos > 0.5 ? pos : 0);
              }}
              onDragEnd={() => {
                draggingOut.current = false;
              }}
              className="flex cursor-grab items-center gap-1.5 truncate active:cursor-grabbing"
              title={
                controls
                  ? `Drag onto player A/B${pos > 0.5 ? ` (starts at ${tenths(pos)})` : ""} or into the queue`
                  : undefined
              }
            >
              <GripVertical className="size-4 shrink-0 text-faint" aria-hidden />
              <span className="truncate">{trackLine(track)}</span>
            </p>
            <div className="mt-2 flex items-center gap-2">
              <Button
                size="sm"
                onClick={toggle}
                aria-label={playing ? "Pause pre-listen" : "Play pre-listen"}
              >
                {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
              </Button>
              <Button size="sm" tone="ghost" onClick={stop} aria-label="Stop pre-listen">
                <Square className="size-3.5" fill="currentColor" />
              </Button>
              <input
                type="range"
                min={0}
                max={Math.max(0.1, track.duration)}
                step={0.1}
                value={pos}
                onChange={(e) => seek(Number(e.target.value))}
                aria-label="Pre-listen position"
                className="flex-1 accent-info"
              />
              <span className="w-24 text-right font-display text-sm tnum text-muted">
                {tenths(pos)} / {tenths(track.duration)}
              </span>
            </div>
            <div className="mt-1 flex gap-3 text-xs text-faint">
              <span className={cx(track.intro !== null && pos < track.intro && "text-info")}>
                Intro {track.intro !== null ? tenths(Math.max(0, track.intro - pos)) : "–"}
              </span>
              <span className={cx(track.outro !== null && pos >= track.outro && "text-tally")}>
                Outro {track.outro !== null ? tenths(Math.max(0, track.outro - pos)) : "–"}
              </span>
            </div>
            {controls ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {(["A", "B"] as const).map((p) => (
                  <Button
                    key={p}
                    size="sm"
                    disabled={!loadable[p]}
                    onClick={() => sendTo(p)}
                    title={
                      loadable[p]
                        ? `Load into player ${p} from this position`
                        : `Player ${p} is on air`
                    }
                  >
                    To {p}
                    {pos > 0.5 ? ` @ ${tenths(pos)}` : ""}
                  </Button>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted">
            Drag a track here from the library or the queue, use Find, or press the headphones on a
            player or queue item to listen before it goes on air.
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-xs text-muted">
          <label htmlFor="cue-volume">Volume</label>
          <input
            id="cue-volume"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            className="w-24 accent-info"
          />
          {canPickOutput && outputs.length > 1 ? (
            <Select
              aria-label="Pre-listen output"
              className="h-7 min-w-0 flex-1 text-xs"
              value={sink}
              onChange={(e) => {
                setSink(e.target.value);
                localStorage.setItem(SINK_KEY, e.target.value);
              }}
            >
              {outputs.map((o) => (
                <option key={o.deviceId} value={o.deviceId === "default" ? "" : o.deviceId}>
                  {o.label || "Output device"}
                </option>
              ))}
            </Select>
          ) : null}
        </div>
        <p className="mt-2 text-xs text-faint">
          Plays only in this browser; listeners never hear it.
        </p>
      </Panel>
    </div>
  );
}
