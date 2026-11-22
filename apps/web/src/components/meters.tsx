/** Segmented VU meters and the studio clock (the console's signature element). */
import { useEffect, useState } from "react";
import { cx } from "./ui";

const SEGMENTS = 30;
const MIN_DB = -48;

function segColor(i: number): string {
  const db = MIN_DB + ((i + 1) / SEGMENTS) * -MIN_DB;
  if (db > -3) return "bg-clip";
  if (db > -12) return "bg-tally";
  return "bg-signal";
}

export function VuBar({
  peak,
  rms,
  label,
  vertical = false,
}: {
  peak: number;
  rms: number;
  label?: string;
  vertical?: boolean;
}) {
  const lit = Math.round(((Math.max(MIN_DB, Math.min(0, rms)) - MIN_DB) / -MIN_DB) * SEGMENTS);
  const peakSeg =
    Math.round(((Math.max(MIN_DB, Math.min(0, peak)) - MIN_DB) / -MIN_DB) * SEGMENTS) - 1;
  return (
    <div
      className={cx("flex gap-2", vertical ? "flex-col-reverse items-center" : "items-center")}
      role="meter"
      aria-label={label ?? "level"}
      aria-valuemin={MIN_DB}
      aria-valuemax={0}
      aria-valuenow={Math.round(rms)}
    >
      {label ? <span className="w-20 shrink-0 text-xs text-muted">{label}</span> : null}
      <div className={cx("flex gap-[2px]", vertical ? "h-40 flex-col-reverse" : "h-3 flex-1")}>
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <span
            key={i}
            className={cx(
              vertical ? "h-full w-3" : "h-full flex-1",
              "rounded-[1px]",
              i < lit || i === peakSeg ? segColor(i) : "bg-line",
              i === peakSeg && i >= lit ? "opacity-80" : "",
            )}
            style={vertical ? { height: `${100 / SEGMENTS}%` } : undefined}
          />
        ))}
      </div>
      <span className="w-12 shrink-0 text-right font-display text-sm tnum text-muted">
        {rms <= -100 ? "–∞" : rms.toFixed(0)}
      </span>
    </div>
  );
}

/** Counts down to the next locked news boundary; amber tally when on air. */
export function StudioClock({
  timeZone,
  nextBoundaryMs,
  onAir,
  live,
}: {
  timeZone: string;
  nextBoundaryMs: number | null;
  onAir: boolean;
  live: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const toNews = nextBoundaryMs ? Math.max(0, Math.round((nextBoundaryMs - now) / 1000)) : null;
  const seconds = Number(get("second"));
  return (
    <div className="flex items-center gap-4">
      <span
        className={cx(
          "inline-flex h-7 items-center gap-2 rounded px-2.5 font-display text-sm font-semibold tracking-wider",
          live
            ? "bg-clip text-white tally-live"
            : onAir
              ? "bg-tally text-desk"
              : "border border-line-strong text-faint",
        )}
      >
        <span className={cx("size-2 rounded-full", live || onAir ? "bg-current" : "bg-faint")} />
        {live ? "Live mic" : onAir ? "On air" : "Off air"}
      </span>
      <div className="flex items-baseline gap-1 font-display tnum" aria-label="Station time">
        <span className="text-3xl font-semibold leading-none">
          {get("hour")}:{get("minute")}
        </span>
        <span className="w-7 text-xl leading-none text-tally">
          {String(seconds).padStart(2, "0")}
        </span>
      </div>
      {toNews !== null ? (
        <div className="hidden flex-col leading-tight sm:flex">
          <span className="text-xs text-muted">News in</span>
          <span
            className={cx(
              "font-display text-lg font-semibold tnum leading-none",
              toNews <= 60 ? "text-tally" : "text-legend",
            )}
          >
            {Math.floor(toNews / 60)}:{String(toNews % 60).padStart(2, "0")}
          </span>
        </div>
      ) : null}
    </div>
  );
}
