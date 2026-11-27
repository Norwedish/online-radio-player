/**
 * Automation side of the studio: what automation has on air, its transport,
 * and the queue (reorder, jump, remove, or pull an item into a studio player).
 */
import { useState, type DragEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  GripVertical,
  Headphones,
  ListPlus,
  Mic2,
  Pause,
  Play,
  Repeat,
  SkipForward,
  Square,
  Trash2,
} from "lucide-react";
import { clock, mmss, trackLine } from "../../lib/format";
import type { PlayoutState, QueueItem, StudioPlayerId } from "../../lib/types";
import { KindBadge, NowPlayingCard, command } from "../console";
import { Badge, Button, ConfirmButton, Empty, Panel, cx } from "../ui";
import { droppedMedia, droppedQueueUid, isMediaDrag, startQueueDrag } from "./drag";

export function AutomationPanel({
  state,
  controls,
  onQueueTrack,
  onVoiceOver,
}: {
  state: PlayoutState | null;
  controls: boolean;
  onQueueTrack: () => void;
  onVoiceOver: () => void;
}) {
  const manual = Boolean(state?.studio?.manual);
  return (
    <Panel
      title="Automation"
      actions={
        manual ? (
          <Badge tone="warn">on hold</Badge>
        ) : state?.stopped ? (
          <Badge>stopped</Badge>
        ) : (
          <Badge tone="good">running</Badge>
        )
      }
    >
      {manual ? (
        <p className="text-sm text-muted">
          The studio players are on air. Automation resumes the held track (or the schedule) when
          you hand back.
        </p>
      ) : (
        <NowPlayingCard np={state?.nowPlaying ?? null} paused={state?.paused} compact />
      )}
      {controls ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {state?.stopped ? (
            <Button tone="primary" onClick={() => command("/api/playout/play")} disabled={manual}>
              <Play className="size-4" /> Start automation
            </Button>
          ) : state?.paused ? (
            <Button tone="primary" onClick={() => command("/api/playout/resume")}>
              <Play className="size-4" /> Resume
            </Button>
          ) : (
            <Button onClick={() => command("/api/playout/pause")} disabled={manual}>
              <Pause className="size-4" /> Pause
            </Button>
          )}
          <Button
            onClick={() => command("/api/playout/skip")}
            disabled={!state?.nowPlaying || manual}
          >
            <SkipForward className="size-4" /> Skip
          </Button>
          <Button onClick={() => command("/api/playout/replay-last")} disabled={manual}>
            <Repeat className="size-4" /> Replay last
          </Button>
          <ConfirmButton
            tone="ghost"
            onConfirm={() => command("/api/playout/stop")}
            confirmLabel="Confirm stop"
            disabled={manual}
          >
            <Square className="size-4" /> Stop
          </ConfirmButton>
          <span className="ml-auto flex gap-2">
            <Button size="sm" onClick={onQueueTrack}>
              <ListPlus className="size-4" /> Queue a track
            </Button>
            <Button size="sm" onClick={onVoiceOver} disabled={state?.voiceOver.active}>
              <Mic2 className="size-4" />{" "}
              {state?.voiceOver.active ? "Voice-over on air" : "Voice-over"}
            </Button>
          </span>
        </div>
      ) : null}
    </Panel>
  );
}

function QueueRow({
  item,
  index,
  total,
  controls,
  loadable,
  onDrop,
  onPreview,
}: {
  item: QueueItem;
  index: number;
  total: number;
  controls: boolean;
  loadable: Record<StudioPlayerId, boolean>;
  /** A queue item or a library track was dropped here (inserted before this row). */
  onDrop: (e: DragEvent) => void;
  onPreview: () => void;
}) {
  const [over, setOver] = useState(false);
  const btn = "rounded p-1 hover:bg-panel-2 disabled:opacity-30";
  return (
    <li
      // Any item with a track can be dragged onto pre-listen; only unlocked ones reorder.
      draggable={Boolean(item.mediaId) || (controls && !item.locked)}
      onDragStart={(e) => startQueueDrag(e, item)}
      onDragOver={(e) => {
        if (!controls) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        onDrop(e);
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
      <span className="flex shrink-0 gap-0.5 opacity-60 group-hover:opacity-100 group-focus-within:opacity-100">
        {item.mediaId ? (
          <button
            type="button"
            className={btn}
            aria-label={`Pre-listen ${item.title}`}
            onClick={onPreview}
          >
            <Headphones className="size-4" />
          </button>
        ) : null}
        {controls ? (
          <>
            {(["A", "B"] as const).map((p) => (
              <button
                key={p}
                type="button"
                className={cx(btn, "w-6 font-display font-semibold")}
                disabled={!loadable[p]}
                aria-label={`Load ${item.title} into player ${p}`}
                title={loadable[p] ? `Load into player ${p}` : `Player ${p} is on air`}
                onClick={() =>
                  command(
                    `/api/studio/players/${p}/load`,
                    { uid: item.uid },
                    "POST",
                    `Loaded into ${p}`,
                  )
                }
              >
                {p}
              </button>
            ))}
            {!item.locked ? (
              <>
                <button
                  type="button"
                  className={btn}
                  aria-label={`Move ${item.title} up`}
                  disabled={index === 0}
                  onClick={() =>
                    command("/api/playout/queue/move", {
                      uid: item.uid,
                      toIndex: Math.max(0, index - 1),
                    })
                  }
                >
                  <ArrowUp className="size-4" />
                </button>
                <button
                  type="button"
                  className={btn}
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
                  className={btn}
                  aria-label={`Play ${item.title} now`}
                  onClick={() => command("/api/playout/queue/jump", { uid: item.uid })}
                >
                  <Play className="size-4" />
                </button>
                <button
                  type="button"
                  className={cx(btn, "text-clip")}
                  aria-label={`Remove ${item.title}`}
                  onClick={() =>
                    command(
                      `/api/playout/queue/${encodeURIComponent(item.uid)}`,
                      undefined,
                      "DELETE",
                    )
                  }
                >
                  <Trash2 className="size-4" />
                </button>
              </>
            ) : null}
          </>
        ) : null}
      </span>
    </li>
  );
}

export function QueuePanel({
  state,
  controls,
  loadable,
  onPreview,
}: {
  state: PlayoutState | null;
  controls: boolean;
  loadable: Record<StudioPlayerId, boolean>;
  onPreview: (item: QueueItem) => void;
}) {
  const [endOver, setEndOver] = useState(false);
  const queue = state?.queue ?? [];
  /** Inserts a dropped library track; false when the drop was something else. */
  const insertDropped = (e: DragEvent, position: number | "end") => {
    const dropped = droppedMedia(e);
    if (dropped === null) return false;
    void command(
      "/api/playout/queue/insert",
      { mediaId: dropped.mediaId, position },
      "POST",
      "Added to the queue",
    );
    return true;
  };
  return (
    <Panel
      title="Queue"
      actions={
        <span className="text-sm text-muted">
          {queue.length} items · mode {state?.mode ?? "–"}
        </span>
      }
      bodyClass="p-0"
    >
      {/* Dropping a library track below the last item adds it at the end. */}
      <div
        onDragOver={(e) => {
          if (!controls || !isMediaDrag(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          if (!endOver) setEndOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setEndOver(false);
        }}
        onDrop={(e) => {
          setEndOver(false);
          if (insertDropped(e, "end")) e.preventDefault();
        }}
      >
        {queue.length === 0 && !endOver ? (
          <div className="p-4">
            <Empty title="The queue is empty">
              Generate plans on the Schedule page, or drag a track here from the library.
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
                loadable={loadable}
                onPreview={() => onPreview(item)}
                onDrop={(e) => {
                  setEndOver(false);
                  if (insertDropped(e, i)) return;
                  // Reorder: the dragged queue item (locked items stay where they are).
                  const uid = droppedQueueUid(e);
                  const dragged = queue.find((q) => q.uid === uid);
                  if (dragged && !dragged.locked && uid !== item.uid)
                    void command("/api/playout/queue/move", { uid, toIndex: i });
                }}
              />
            ))}
          </ol>
        )}
        {endOver ? (
          <p className="m-2 rounded border-2 border-dashed border-tally px-3 py-2 text-center text-sm text-tally">
            Drop to add at the end of the queue
          </p>
        ) : null}
      </div>
    </Panel>
  );
}
