import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { get } from "../../lib/api";
import { hourLabel } from "../../lib/format";
import { brandStyle, useNowPlaying } from "./Listen";

interface PublicHour {
  hour: number;
  title: string;
  live: boolean;
  current: boolean;
  tracks: { at: number; artist: string | null; title: string | null }[];
}

export default function PublicSchedule() {
  const np = useNowPlaying();
  const [offset, setOffset] = useState(0);
  const today = useQuery({
    queryKey: ["pub-sched-today"],
    queryFn: () => get<{ date: string }>("/api/public/schedule"),
  });
  const date = today.data
    ? new Date(Date.parse(`${today.data.date}T12:00:00Z`) + offset * 86_400_000)
        .toISOString()
        .slice(0, 10)
    : undefined;
  const sched = useQuery({
    queryKey: ["pub-sched", date],
    queryFn: () =>
      get<{ date: string; timezone: string; hours: PublicHour[] }>(
        `/api/public/schedule?date=${date}`,
      ),
    enabled: Boolean(date),
  });
  const [open, setOpen] = useState<number | null>(null);
  const label = (o: number) => (o === 0 ? "Today" : o === 1 ? "Tomorrow" : "Yesterday");
  return (
    <div
      style={brandStyle(np.data?.station.colors)}
      className="min-h-screen bg-[var(--brand-bg)] text-legend"
    >
      <div className="mx-auto max-w-3xl px-5 pb-16 pt-6">
        <header className="mb-8 flex items-center gap-3">
          <span className="size-3 rounded-full bg-[var(--brand)]" aria-hidden />
          <Link to="/listen" className="font-display text-2xl font-semibold tracking-wide">
            {np.data?.station.name ?? "Radio"}
          </Link>
          <Link to="/listen" className="ml-auto text-sm text-muted hover:text-legend">
            Listen live
          </Link>
        </header>
        <h1 className="font-display text-5xl font-semibold">Schedule</h1>
        <p className="mt-1 text-muted">
          News on the hour and half hour. Times in {sched.data?.timezone ?? "station time"}.
        </p>
        <div className="mt-6 flex gap-2" role="tablist">
          {[-1, 0, 1].map((o) => (
            <button
              key={o}
              type="button"
              role="tab"
              aria-selected={offset === o}
              onClick={() => setOffset(o)}
              className={`rounded-md px-3 py-1.5 text-sm ${offset === o ? "bg-[var(--brand)] text-black" : "border border-line-strong text-muted hover:text-legend"}`}
            >
              {label(o)}
            </button>
          ))}
        </div>
        <ol className="mt-6 divide-y divide-line border-y border-line">
          {sched.data?.hours.map((h) => (
            <li key={h.hour} className={h.current ? "bg-white/5" : ""}>
              <button
                type="button"
                className="flex w-full items-baseline gap-5 px-2 py-3 text-left"
                onClick={() => setOpen(open === h.hour ? null : h.hour)}
                aria-expanded={open === h.hour}
              >
                <span className="w-16 font-display text-2xl tnum">{hourLabel(h.hour)}</span>
                <span className="flex-1 text-lg">{h.title || "Music"}</span>
                {h.live ? (
                  <span className="rounded bg-[var(--brand)] px-2 text-sm font-semibold text-black">
                    Live
                  </span>
                ) : null}
                {h.current ? <span className="text-sm text-[var(--brand)]">On air</span> : null}
              </button>
              {open === h.hour ? (
                <ul className="pb-3 pl-[5.25rem] text-sm text-muted">
                  {h.tracks.length ? (
                    h.tracks.map((t, i) => (
                      <li key={i}>
                        {t.artist} – {t.title}
                      </li>
                    ))
                  ) : (
                    <li>The playlist for this hour isn't published yet.</li>
                  )}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
