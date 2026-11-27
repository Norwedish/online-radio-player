/**
 * One on-air studio player (A/B): transport, timers (elapsed, remaining,
 * intro, outro, cue), seekable progress bar with markers, fader and meter.
 * Positions come from the 10 Hz meter frames, so the timers run smoothly.
 */
import { useState, type KeyboardEvent, type MouseEvent } from "react";
import {
  ArrowDownToLine,
  Eject,
  FolderOpen,
  Headphones,
  Pause,
  Play,
  Repeat,
  SkipForward,
  Square,
  TrendingDown,
} from "lucide-react";
import { useLive } from "../../hooks/live";
import { trackLine } from "../../lib/format";
import type { StudioPlayer } from "../../lib/types";
import { command } from "../console";
import { VuBar } from "../meters";
import { Badge, Button, cx } from "../ui";
import { droppedMedia, isMediaDrag } from "./drag";

/** m:ss.t for the big studio timers. */
export function tenths(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "–:––.–";
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, "0")}`;
}

const STATUS: Record<
  StudioPlayer["status"],
  { label: string; tone: "bad" | "warn" | "good" | "neutral" }
> = {
  playing: { label: "On air", tone: "bad" },
  paused: { label: "Paused", tone: "warn" },
  loaded: { label: "Cued", tone: "good" },
  empty: { label: "Empty", tone: "neutral" },
};

export function PlayerDeck({
  player,
  controls,
  onLoad,
  onPreview,
}: {
  player: StudioPlayer;
  controls: boolean;
  /** Open the library drawer to load this player. */
  onLoad: () => void;
  /** Send the loaded track to the headphone cue player. */
  onPreview: () => void;
}) {
  const id = player.id;
  const live = useLive((s) => s.meter?.players?.find((p) => p.id === id));
  const [gain, setGain] = useState<number | null>(null);
  const item = player.item;
  const base = `/api/studio/players/${id}`;
  // Live position from the meter stream while the player runs; the state otherwise.
  const pos = player.status === "playing" && live ? live.position : player.position;
  const dur = item?.duration ?? 0;
  const remaining = Math.max(0, dur - pos);
  const intro = item?.intro ?? null;
  const outro = item?.outro ?? null;
  const toIntro = intro !== null && pos < intro ? intro - pos : null;
  const toOutro = outro !== null && pos < outro ? outro - pos : null;
  const inOutro = outro !== null && pos >= outro;
  const onAir = player.status === "playing";
  const pct = (v: number) => (dur > 0 ? Math.min(100, Math.max(0, (v / dur) * 100)) : 0);

  const seekAt = (e: MouseEvent<HTMLDivElement>) => {
    if (!controls || !item || dur <= 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const position = ((e.clientX - r.left) / r.width) * dur;
    void command(`${base}/seek`, { position: Math.max(0, Math.min(dur - 0.2, position)) });
  };
  const seekKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!controls || !item) return;
    const step = e.shiftKey ? 10 : 2;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const position = Math.max(
        0,
        Math.min(dur - 0.2, pos + (e.key === "ArrowRight" ? step : -step)),
      );
      void command(`${base}/seek`, { position });
    }
  };
  const sendGain = () => {
    if (gain === null) return;
    void command(base, { gainDb: gain }, "PATCH").then(() => setGain(null));
  };
  const shownGain = gain ?? player.gainDb;
  // A library track dragged over the player (from the library drawer).
  const [dropOver, setDropOver] = useState(false);

  return (
    <section
      aria-label={`Player ${id}`}
      onDragOver={(e) => {
        if (!controls || !isMediaDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = onAir ? "none" : "copy";
        if (!dropOver) setDropOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOver(false);
      }}
      onDrop={(e) => {
        setDropOver(false);
        const dropped = droppedMedia(e);
        if (dropped === null || onAir) return;
        e.preventDefault();
        void command(
          `${base}/load`,
          dropped,
          "POST",
          `Loaded into ${id}${dropped.cuePoint ? ` at ${tenths(dropped.cuePoint)}` : ""}`,
        );
      }}
      className={cx(
        "relative flex flex-col gap-3 rounded-lg border bg-panel p-4",
        onAir ? "border-clip/70 shadow-[0_0_0_1px_rgb(255_77_79/0.25)]" : "border-line",
      )}
    >
      {dropOver ? (
        <div
          className={cx(
            "pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed font-display text-xl font-semibold",
            onAir ? "border-clip bg-clip/15 text-clip" : "border-tally bg-desk/80 text-tally",
          )}
          aria-hidden
        >
          {onAir ? `Player ${id} is on air` : `Drop to load into ${id}`}
        </div>
      ) : null}
      <header className="flex items-center gap-2">
        <span
          className={cx(
            "flex size-8 items-center justify-center rounded font-display text-xl font-bold",
            onAir ? "bg-clip text-white" : "bg-panel-2 text-legend",
          )}
        >
          {id}
        </span>
        <Badge tone={STATUS[player.status].tone}>{STATUS[player.status].label}</Badge>
        {player.fading ? <Badge tone="warn">fading</Badge> : null}
        {player.loop ? <Badge tone="info">loop</Badge> : null}
        {player.autoNext ? <Badge tone="info">auto-next</Badge> : null}
        <span className="ml-auto font-display text-sm tnum text-faint">
          {dur ? tenths(dur) : ""}
        </span>
      </header>

      <div className="min-h-12">
        <p className="truncate font-display text-xl font-semibold leading-tight">
          {item ? item.title || trackLine(item) : "No track loaded"}
        </p>
        <p className="truncate text-sm text-muted">{item?.kind === "news" ? "" : item?.artist}</p>
      </div>

      {/* Timers: remaining is the one that matters on air. */}
      <div className="grid grid-cols-[1fr_auto] items-end gap-2">
        <div>
          <span className="text-xs uppercase tracking-wider text-faint">Remaining</span>
          <p
            className={cx(
              "font-display text-4xl font-semibold leading-none tnum",
              onAir && remaining < 10 ? "text-clip" : onAir && remaining < 30 ? "text-tally" : "",
            )}
            aria-label={`Player ${id} remaining`}
          >
            −{tenths(item ? remaining : null)}
          </p>
        </div>
        <div className="text-right">
          <span className="text-xs uppercase tracking-wider text-faint">Elapsed</span>
          <p className="font-display text-2xl leading-none tnum text-muted">
            {tenths(item ? pos : null)}
          </p>
        </div>
      </div>
      <dl className="grid grid-cols-4 gap-2 text-center">
        <Timer
          label="Intro"
          value={toIntro}
          hint={intro === null ? "not set" : toIntro === null ? "vocals" : ""}
          accent="info"
        />
        <Timer
          label={inOutro ? "In outro" : "Outro"}
          value={inOutro ? remaining : toOutro}
          hint={outro === null ? "not set" : ""}
          accent="tally"
        />
        <Timer label="Cue" value={item ? player.cuePoint : null} />
        <Timer
          label="Loop"
          value={player.loop && item ? Math.max(0, dur - player.cuePoint) : null}
          hint={player.loop ? "" : "off"}
        />
      </dl>

      {/* Progress: click or arrow keys to seek; markers for cue, intro and outro. */}
      <div
        role="slider"
        tabIndex={controls && item ? 0 : -1}
        aria-label={`Player ${id} position`}
        aria-valuemin={0}
        aria-valuemax={Math.round(dur)}
        aria-valuenow={Math.round(pos)}
        aria-valuetext={`${tenths(pos)} of ${tenths(dur)}`}
        onClick={seekAt}
        onKeyDown={seekKey}
        className={cx(
          "relative h-6 overflow-hidden rounded bg-desk",
          controls && item ? "cursor-pointer" : "",
        )}
      >
        {intro !== null ? (
          <span
            className="absolute inset-y-0 left-0 bg-info/20"
            style={{ width: `${pct(intro)}%` }}
          />
        ) : null}
        {outro !== null ? (
          <span
            className="absolute inset-y-0 right-0 bg-tally/15"
            style={{ left: `${pct(outro)}%` }}
          />
        ) : null}
        <span
          className={cx("absolute inset-y-0 left-0", onAir ? "bg-legend/35" : "bg-legend/20")}
          style={{ width: `${pct(pos)}%` }}
        />
        {item ? (
          <span
            className="absolute inset-y-0 w-0.5 bg-signal"
            style={{ left: `${pct(player.cuePoint)}%` }}
            title={`Cue ${tenths(player.cuePoint)}`}
          />
        ) : null}
        <span
          className="absolute inset-y-0 w-0.5 bg-legend"
          style={{ left: `${pct(pos)}%` }}
          aria-hidden
        />
      </div>

      {controls ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="lg"
              tone={onAir ? "default" : "primary"}
              disabled={!item}
              onClick={() => command(`${base}/${onAir && !player.fading ? "pause" : "play"}`)}
              aria-label={onAir && !player.fading ? `Pause player ${id}` : `Play player ${id}`}
            >
              {onAir && !player.fading ? <Pause className="size-5" /> : <Play className="size-5" />}
            </Button>
            <Button
              size="lg"
              disabled={!item || player.status === "loaded"}
              onClick={() => command(`${base}/stop`)}
              aria-label={`Stop player ${id} (back to cue)`}
              title="Stop and return to the cue point"
            >
              <Square className="size-4" fill="currentColor" />
            </Button>
            <Button
              size="lg"
              disabled={!onAir || player.fading}
              onClick={() => command(`${base}/fade`, { seconds: 3 })}
              title="Fade out over 3 s, then stop at the cue point"
            >
              <TrendingDown className="size-4" /> Fade
            </Button>
            <Button
              size="lg"
              tone="ghost"
              disabled={!item}
              onClick={() => command(base, { cuePoint: Math.max(0, pos) }, "PATCH")}
              title="Set the cue point to the current position"
            >
              <ArrowDownToLine className="size-4" /> Cue here
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              tone={player.loop ? "primary" : "default"}
              aria-pressed={player.loop}
              disabled={!item}
              onClick={() => command(base, { loop: !player.loop }, "PATCH")}
            >
              <Repeat className="size-4" /> Loop
            </Button>
            <Button
              size="sm"
              tone={player.autoNext ? "primary" : "default"}
              aria-pressed={player.autoNext}
              onClick={() => command(base, { autoNext: !player.autoNext }, "PATCH")}
              title={`When ${id} ends or fades out, start player ${id === "A" ? "B" : "A"}`}
            >
              <SkipForward className="size-4" /> Auto-next
            </Button>
            <Button
              size="sm"
              tone="ghost"
              disabled={!item || player.cuePoint === 0}
              onClick={() => command(base, { cuePoint: 0 }, "PATCH")}
            >
              Reset cue
            </Button>
            <span className="ml-auto flex gap-1">
              <Button
                size="sm"
                tone="ghost"
                disabled={!item}
                onClick={onPreview}
                title="Pre-listen in your headphones"
              >
                <Headphones className="size-4" />
                <span className="sr-only">Pre-listen player {id}</span>
              </Button>
              <Button size="sm" disabled={onAir} onClick={onLoad}>
                <FolderOpen className="size-4" /> Load
              </Button>
              <Button
                size="sm"
                tone="ghost"
                disabled={!item || onAir}
                onClick={() => command(`${base}/eject`)}
                aria-label={`Eject player ${id}`}
              >
                <Eject className="size-4" />
              </Button>
            </span>
          </div>
        </>
      ) : null}

      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <VuBar label={`Level ${id}`} peak={live?.peak ?? -120} rms={live?.rms ?? -120} />
        <div className="flex items-center gap-3 text-sm">
          <label htmlFor={`fader-${id}`} className="w-20 text-xs text-muted">
            Fader
          </label>
          <input
            id={`fader-${id}`}
            type="range"
            min={-40}
            max={6}
            step={0.5}
            disabled={!controls}
            value={Math.max(-40, shownGain)}
            onChange={(e) => {
              const v = Number(e.target.value);
              setGain(v <= -40 ? -60 : v);
            }}
            onPointerUp={sendGain}
            onKeyUp={sendGain}
            onDoubleClick={() => command(base, { gainDb: 0 }, "PATCH")}
            className="flex-1 accent-tally"
            title="Double-click for 0 dB"
          />
          <span className="w-14 text-right font-display tnum">
            {shownGain <= -60 ? "−∞" : `${shownGain > 0 ? "+" : ""}${shownGain.toFixed(1)}`} dB
          </span>
        </div>
      </div>
    </section>
  );
}

function Timer({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: number | null;
  hint?: string;
  accent?: "info" | "tally";
}) {
  const active = value !== null;
  return (
    <div className="rounded bg-desk px-1.5 py-1">
      <dt className="text-[11px] uppercase tracking-wider text-faint">{label}</dt>
      <dd
        className={cx(
          "font-display text-lg leading-tight tnum",
          !active
            ? "text-faint"
            : accent === "info"
              ? "text-info"
              : accent === "tally"
                ? "text-tally"
                : "text-legend",
        )}
      >
        {active ? tenths(value) : hint || "–"}
      </dd>
    </div>
  );
}
