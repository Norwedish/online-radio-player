import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  GripVertical,
  ListPlus,
  Mic2,
  Pause,
  Play,
  Repeat,
  SkipForward,
  Square,
  Trash2,
  Zap,
} from "lucide-react";
import { useAuth } from "../../hooks/auth";
import { useLive } from "../../hooks/live";
import { get } from "../../lib/api";
import { clock, mmss, trackLine } from "../../lib/format";
import type { Media, Playlist, PlayoutState, QueueItem } from "../../lib/types";
import { KindBadge, MediaPicker, NowPlayingCard, command } from "../../components/console";
import { VuBar } from "../../components/meters";
import { Badge, Button, ConfirmButton, Empty, Panel, PageHeader, cx } from "../../components/ui";

const BOUNDARY_LABEL: Record<string, string> = {
  cut: "Cut at boundary",
  let_finish: "Let finish",
  early_news: "News early",
  late_news: "News late",
  none: "On time",
};

function QueueRow({
  item,
  index,
  total,
  controls,
  onDragStart,
  onDrop,
}: {
  item: QueueItem;
  index: number;
  total: number;
  controls: boolean;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <li
      draggable={controls && !item.locked}
      onDragStart={onDragStart}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={() => {
        setOver(false);
        onDrop();
      }}
      className={cx(
        "group flex items-center gap-2 border-b border-line px-2 py-2 text-sm",
        item.locked && "bg-tally/5",
        over && "border-t-2 border-t-tally",
      )}
    >
      {controls ? (
        <GripVertical
          className={cx(
            "size-4 shrink-0",
            item.locked ? "text-transparent" : "cursor-grab text-faint",
          )}
          aria-hidden
        />
      ) : null}
      <span className="w-12 shrink-0 font-display tnum text-faint">
        {item.plannedStart ? clock(item.plannedStart, undefined, false) : ""}
      </span>
      <span className="min-w-0 flex-1 truncate">{trackLine(item)}</span>
      <KindBadge kind={item.kind} source={item.source} />
      {item.locked ? <Badge tone="warn">locked</Badge> : null}
      <span className="w-12 shrink-0 text-right font-display tnum text-muted">
        {mmss(item.duration)}
      </span>
      {controls && !item.locked ? (
        <span className="flex shrink-0 gap-0.5 opacity-60 group-hover:opacity-100 group-focus-within:opacity-100">
          <button
            type="button"
            className="rounded p-1 hover:bg-panel-2"
            aria-label={`Move ${item.title} up`}
            disabled={index === 0}
            onClick={() =>
              command("/api/playout/queue/move", { uid: item.uid, toIndex: Math.max(0, index - 1) })
            }
          >
            <ArrowUp className="size-4" />
          </button>
          <button
            type="button"
            className="rounded p-1 hover:bg-panel-2"
            aria-label={`Move ${item.title} down`}
            disabled={index === total - 1}
            onClick={() =>
              command("/api/playout/queue/move", { uid: item.uid, toIndex: index + 1 })
            }
          >
            <ArrowDown className="size-4" />
          </button>
          <button
            type="button"
            className="rounded p-1 hover:bg-panel-2"
            aria-label={`Play ${item.title} now`}
            onClick={() => command("/api/playout/queue/jump", { uid: item.uid })}
          >
            <Play className="size-4" />
          </button>
          <button
            type="button"
            className="rounded p-1 text-clip hover:bg-panel-2"
            aria-label={`Remove ${item.title}`}
            onClick={() =>
              command(`/api/playout/queue/${encodeURIComponent(item.uid)}`, undefined, "DELETE")
            }
          >
            <Trash2 className="size-4" />
          </button>
        </span>
      ) : null}
    </li>
  );
}

export default function Playout() {
  const { can } = useAuth();
  const controls = can("playout:control");
  const state = useLive((s) => s.state) as PlayoutState | null;
  const meter = useLive((s) => s.meter);
  const [picker, setPicker] = useState<null | "insert" | "playnow" | "voiceover">(null);
  const [dragUid, setDragUid] = useState<string | null>(null);
  const [fader, setFader] = useState<number | null>(null);
  const playlists = useQuery({
    queryKey: ["playlists"],
    queryFn: () => get<{ items: Playlist[] }>("/api/playlists"),
  });
  const jinglesId = playlists.data?.items.find((p) => p.role === "jingle")?.id;
  const carts = useQuery({
    queryKey: ["carts", jinglesId],
    queryFn: () => get<{ items: { media: Media }[] }>(`/api/playlists/${jinglesId}`),
    enabled: Boolean(jinglesId),
  });

  // Keyboard shortcuts: space = pause/resume, → = skip, R = replay last.
  useEffect(() => {
    if (!controls) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (
        ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(t.tagName) ||
        t.isContentEditable ||
        document.querySelector("dialog[open]")
      )
        return;
      if (e.code === "Space") {
        e.preventDefault();
        void command(state?.paused ? "/api/playout/resume" : "/api/playout/pause");
      } else if (e.key === "ArrowRight") void command("/api/playout/skip");
      else if (e.key.toLowerCase() === "r" && !e.metaKey && !e.ctrlKey)
        void command("/api/playout/replay-last");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [controls, state?.paused]);

  const queue = state?.queue ?? [];
  const pick = async (m: Media) => {
    if (picker === "insert")
      await command(
        "/api/playout/queue/insert",
        { mediaId: m.id, position: "next" },
        "POST",
        `Queued ${m.title ?? "track"} next`,
      );
    if (picker === "playnow")
      await command("/api/playout/play-now", { mediaId: m.id, kind: "stinger" });
    if (picker === "voiceover") await command("/api/playout/voice-over", { mediaId: m.id });
    setPicker(null);
  };

  return (
    <>
      <PageHeader
        title="Playout"
        description={
          controls
            ? "Space pauses or resumes, → skips, R replays the last track. Drag the queue to reorder; news stays locked."
            : "Read-only view of the playout queue."
        }
        actions={
          controls ? (
            <ConfirmButton
              onConfirm={() =>
                command("/api/playout/emergency", { action: "trigger", reason: "manual" })
              }
              confirmLabel="Confirm: play emergency loop"
            >
              <Zap className="size-4" /> Emergency
            </ConfirmButton>
          ) : null
        }
      />
      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <div className="flex flex-col gap-4">
          <Panel>
            <NowPlayingCard np={state?.nowPlaying ?? null} paused={state?.paused} />
            {controls ? (
              <div className="mt-5 flex flex-wrap items-center gap-2">
                {state?.stopped ? (
                  <Button tone="primary" size="lg" onClick={() => command("/api/playout/play")}>
                    <Play className="size-5" /> Start automation
                  </Button>
                ) : state?.paused ? (
                  <Button tone="primary" size="lg" onClick={() => command("/api/playout/resume")}>
                    <Play className="size-5" /> Resume
                  </Button>
                ) : (
                  <Button size="lg" onClick={() => command("/api/playout/pause")}>
                    <Pause className="size-5" /> Pause
                  </Button>
                )}
                <Button
                  size="lg"
                  onClick={() => command("/api/playout/skip")}
                  disabled={!state?.nowPlaying}
                >
                  <SkipForward className="size-5" /> Skip
                </Button>
                <Button size="lg" onClick={() => command("/api/playout/replay-last")}>
                  <Repeat className="size-5" /> Replay last
                </Button>
                <ConfirmButton
                  size="lg"
                  tone="ghost"
                  onConfirm={() => command("/api/playout/stop")}
                  confirmLabel="Confirm stop"
                >
                  <Square className="size-5" /> Stop
                </ConfirmButton>
                <div className="ml-auto flex items-center gap-2">
                  <Button onClick={() => setPicker("insert")}>
                    <ListPlus className="size-4" /> Queue a track
                  </Button>
                  <Button onClick={() => setPicker("voiceover")} disabled={state?.voiceOver.active}>
                    <Mic2 className="size-4" />{" "}
                    {state?.voiceOver.active ? "Voice-over on air" : "Voice-over"}
                  </Button>
                </div>
              </div>
            ) : null}
          </Panel>

          <Panel
            title="Queue"
            actions={
              <span className="text-sm text-muted">
                {queue.length} items · mode {state?.mode ?? "–"}
              </span>
            }
            bodyClass="p-0"
          >
            {queue.length === 0 ? (
              <div className="p-4">
                <Empty title="The queue is empty">
                  Generate plans on the Schedule page, or queue a track by hand.
                </Empty>
              </div>
            ) : (
              <ol>
                {queue.slice(0, 60).map((item, i) => (
                  <QueueRow
                    key={item.uid}
                    item={item}
                    index={i}
                    total={queue.length}
                    controls={controls}
                    onDragStart={() => setDragUid(item.uid)}
                    onDrop={() => {
                      if (dragUid && dragUid !== item.uid)
                        void command("/api/playout/queue/move", { uid: dragUid, toIndex: i });
                      setDragUid(null);
                    }}
                  />
                ))}
              </ol>
            )}
          </Panel>
        </div>

        <div className="flex flex-col gap-4">
          <Panel title="Mixer">
            <div className="flex flex-col gap-2">
              <VuBar
                label="Master"
                peak={meter?.masterPeak ?? -120}
                rms={meter?.masterRms ?? -120}
              />
              {meter?.buses
                .filter((b) => b.name !== "event" || state?.event.active)
                .map((b) => (
                  <VuBar
                    key={b.name}
                    label={
                      b.name === "automation"
                        ? "Automation"
                        : b.name === "voiceover"
                          ? "Voice-over"
                          : b.name[0]!.toUpperCase() + b.name.slice(1)
                    }
                    peak={b.peak}
                    rms={b.rms}
                  />
                ))}
            </div>
            <div className="mt-4 flex items-center gap-3 text-sm">
              <label htmlFor="fader" className="w-20 text-muted">
                Master fader
              </label>
              <input
                id="fader"
                type="range"
                min={0}
                max={1.5}
                step={0.01}
                disabled={!controls}
                value={fader ?? state?.fader ?? 1}
                onChange={(e) => setFader(Number(e.target.value))}
                onPointerUp={() =>
                  fader !== null &&
                  command("/api/playout/fader", { value: fader }, "PATCH").then(() =>
                    setFader(null),
                  )
                }
                onKeyUp={() =>
                  fader !== null &&
                  command("/api/playout/fader", { value: fader }, "PATCH").then(() =>
                    setFader(null),
                  )
                }
                className="flex-1 accent-tally"
              />
              <span className="w-12 text-right font-display tnum">
                {Math.round((fader ?? state?.fader ?? 1) * 100)}%
              </span>
            </div>
            {meter ? (
              <p className="mt-2 text-xs text-faint">Ducking {meter.duckGain.toFixed(1)} dB</p>
            ) : null}
          </Panel>

          {controls ? (
            <Panel
              title="Cart wall"
              actions={
                <Button size="sm" tone="ghost" onClick={() => setPicker("playnow")}>
                  Any track
                </Button>
              }
            >
              {carts.data?.items.length ? (
                <div className="grid grid-cols-2 gap-2">
                  {carts.data.items.slice(0, 12).map(({ media }) => (
                    <button
                      key={media.id}
                      type="button"
                      onClick={() =>
                        command("/api/playout/play-now", { mediaId: media.id, kind: "jingle" })
                      }
                      className="rounded-md border border-line-strong bg-panel-2 px-2 py-3 text-left text-sm hover:border-tally"
                    >
                      <span className="block truncate">{media.title ?? "Jingle"}</span>
                      <span className="font-display text-xs tnum text-faint">
                        {mmss(media.duration)}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted">
                  Add jingles and stingers to the Jingles playlist to get one-press buttons here.
                </p>
              )}
            </Panel>
          ) : null}

          <Panel title="Boundary log">
            {state?.boundaryLog.length ? (
              <ul className="flex flex-col gap-2 text-sm">
                {state.boundaryLog.slice(0, 8).map((b, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <span className="w-12 font-display tnum text-faint">
                      {clock(b.boundaryAt, undefined, false)}
                    </span>
                    <Badge
                      tone={b.action === "cut" ? "bad" : b.action === "none" ? "good" : "warn"}
                    >
                      {BOUNDARY_LABEL[b.action]}
                    </Badge>
                    <span className="ml-auto font-display tnum text-muted">
                      {b.deviationMs > 0 ? "+" : ""}
                      {(b.deviationMs / 1000).toFixed(1)} s
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">
                Each news boundary decision (on time, early, late or cut) is listed here.
              </p>
            )}
          </Panel>

          <Panel title="Outputs">
            <ul className="flex flex-col gap-1.5 text-sm">
              {state?.encoders.map((e) => (
                <li key={e.mount} className="flex items-center gap-2">
                  <span
                    className={cx("size-2 rounded-full", e.running ? "bg-signal" : "bg-clip")}
                  />
                  <span>{e.mount}</span>
                  <span className="text-faint">{e.bitrate}</span>
                  {e.restarts ? (
                    <span className="ml-auto text-xs text-tally">{e.restarts} restarts</span>
                  ) : null}
                </li>
              ))}
              {state ? (
                <li className="flex items-center gap-2 border-t border-line pt-1.5">
                  <span
                    className={cx(
                      "size-2 rounded-full",
                      state.stereotool.running
                        ? "bg-signal"
                        : state.stereotool.enabled
                          ? "bg-clip"
                          : "bg-faint",
                    )}
                  />
                  Stereo Tool{" "}
                  <span className="text-faint">
                    {state.stereotool.bypassed ? "bypassed" : state.stereotool.mode}
                  </span>
                </li>
              ) : null}
            </ul>
          </Panel>
        </div>
      </div>
      <MediaPicker
        open={picker !== null}
        onClose={() => setPicker(null)}
        onPick={pick}
        title={
          picker === "voiceover"
            ? "Voice-over: pick a voice track"
            : picker === "playnow"
              ? "Play now: interrupts the current track"
              : "Queue a track next"
        }
      />
    </>
  );
}
