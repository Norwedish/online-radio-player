import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Pause, Play, SkipForward } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useAuth } from "../../hooks/auth";
import { useLive } from "../../hooks/live";
import { get } from "../../lib/api";
import { ago, clock, trackLine } from "../../lib/format";
import type { Alert } from "../../lib/types";
import { KindBadge, NowPlayingCard, command } from "../../components/console";
import { Badge, Button, Panel, PageHeader, severityTone } from "../../components/ui";
import { VuBar } from "../../components/meters";

export default function Dashboard() {
  const { can } = useAuth();
  const state = useLive((s) => s.state);
  const meter = useLive((s) => s.meter);
  const listeners = useLive((s) => s.listeners);
  const alertTick = useLive((s) => s.alertTick);
  const requestTick = useLive((s) => s.requestTick);
  const alerts = useQuery({
    queryKey: ["dash-alerts", alertTick],
    queryFn: () => get<{ items: Alert[] }>("/api/alerts?active=true&limit=5"),
    enabled: can("alerts:view"),
  });
  const series = useQuery({
    queryKey: ["dash-listeners"],
    queryFn: () =>
      get<{ series: { ts: string; listeners: number }[]; peak: number }>(
        "/api/stats/listeners?bucketMinutes=15",
      ),
    refetchInterval: 60_000,
    enabled: can("stats:view"),
  });
  const requests = useQuery({
    queryKey: ["dash-requests", requestTick],
    queryFn: () => get<{ counts: Record<string, number> }>("/api/requests?status=pending&limit=1"),
    enabled: can("requests:moderate"),
  });
  const history = useQuery({
    queryKey: ["dash-history", state?.nowPlaying?.uid],
    queryFn: () =>
      get<{ items: { title: string; artist: string; started_at: string }[] }>(
        "/api/playout/history?limit=6",
      ),
  });

  const byTs = new Map<string, number>();
  for (const p of series.data?.series ?? []) byTs.set(p.ts, (byTs.get(p.ts) ?? 0) + p.listeners);
  const chart = [...byTs.entries()].map(([ts, v]) => ({
    t: clock(Date.parse(ts), undefined, false),
    v,
  }));
  const encodersUp = state?.encoders.filter((e) => e.running).length ?? 0;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="What is on air, how the chain is doing, and what needs attention."
      />
      <div className="grid gap-4 xl:grid-cols-3">
        <Panel
          title="On air"
          className="xl:col-span-2"
          actions={
            can("playout:control") ? (
              <>
                {state?.paused ? (
                  <Button size="sm" onClick={() => command("/api/playout/resume")}>
                    <Play className="size-4" /> Resume
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => command("/api/playout/pause")}>
                    <Pause className="size-4" /> Pause
                  </Button>
                )}
                <Button size="sm" onClick={() => command("/api/playout/skip")}>
                  <SkipForward className="size-4" /> Skip
                </Button>
              </>
            ) : null
          }
        >
          <NowPlayingCard np={state?.nowPlaying ?? null} paused={state?.paused} />
          <div className="mt-5 grid gap-2">
            <VuBar label="Master" peak={meter?.masterPeak ?? -120} rms={meter?.masterRms ?? -120} />
          </div>
          <div className="mt-5">
            <h3 className="mb-2 text-sm text-muted">Up next</h3>
            <ol className="divide-y divide-line">
              {(state?.queue ?? []).slice(0, 4).map((q) => (
                <li key={q.uid} className="flex items-center gap-2 py-1.5 text-sm">
                  <span className="w-14 font-display tnum text-faint">
                    {q.plannedStart ? clock(q.plannedStart, undefined, false) : ""}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{trackLine(q)}</span>
                  <KindBadge kind={q.kind} source={q.source} />
                </li>
              ))}
            </ol>
            <Link
              to="/admin/playout"
              className="mt-2 inline-block text-sm text-tally hover:underline"
            >
              Open the playout console
            </Link>
          </div>
        </Panel>

        <Panel title="Station">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <dt className="text-muted">Listeners</dt>
            <dd className="font-display text-2xl tnum leading-none">{listeners}</dd>
            <dt className="text-muted">Mode</dt>
            <dd className="capitalize">{state?.mode ?? "unknown"}</dd>
            <dt className="text-muted">Encoders</dt>
            <dd>
              <Badge tone={state && encodersUp === state.encoders.length ? "good" : "bad"}>
                {encodersUp}/{state?.encoders.length ?? 0} up
              </Badge>
            </dd>
            <dt className="text-muted">Stereo Tool</dt>
            <dd>
              {state ? (
                <Badge
                  tone={
                    state.stereotool.running ? "good" : state.stereotool.enabled ? "bad" : "neutral"
                  }
                >
                  {state.stereotool.bypassed ? "bypassed" : state.stereotool.mode}
                </Badge>
              ) : (
                "–"
              )}
            </dd>
            <dt className="text-muted">Live</dt>
            <dd>
              {state?.live.active ? <Badge tone="bad">on air ({state.live.mode})</Badge> : "off"}
            </dd>
            <dt className="text-muted">Requests waiting</dt>
            <dd>
              {can("requests:moderate") ? (
                <Link to="/admin/requests" className="font-display text-xl tnum text-tally">
                  {requests.data?.counts.pending ?? 0}
                </Link>
              ) : (
                "–"
              )}
            </dd>
          </dl>
        </Panel>

        <Panel
          title="Listeners today"
          className="xl:col-span-2"
          actions={<span className="text-sm text-muted">Peak {series.data?.peak ?? 0}</span>}
        >
          <div className="h-48">
            {chart.length ? (
              <ResponsiveContainer>
                <AreaChart data={chart} margin={{ left: -20, right: 8, top: 8 }}>
                  <XAxis
                    dataKey="t"
                    stroke="#6b6a65"
                    fontSize={12}
                    tickLine={false}
                    minTickGap={40}
                  />
                  <YAxis stroke="#6b6a65" fontSize={12} tickLine={false} allowDecimals={false} />
                  <Tooltip contentStyle={{ background: "#252931", border: "1px solid #3a3f49" }} />
                  <Area
                    type="monotone"
                    dataKey="v"
                    name="Listeners"
                    stroke="#ffb020"
                    fill="#ffb020"
                    fillOpacity={0.15}
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <p className="pt-10 text-center text-sm text-muted">
                Listener samples appear once Icecast reports stats.
              </p>
            )}
          </div>
        </Panel>

        <Panel
          title="Needs attention"
          actions={
            <Link to="/admin/alerts" className="text-sm text-muted hover:text-legend">
              All alerts
            </Link>
          }
        >
          {alerts.data?.items.length ? (
            <ul className="flex flex-col gap-3">
              {alerts.data.items.map((a) => (
                <li key={a.id} className="text-sm">
                  <Badge tone={severityTone(a.severity)}>{a.severity}</Badge>{" "}
                  <span className="ml-1">{a.message}</span>
                  <p className="text-xs text-faint">{ago(a.created_at)}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No open alerts.</p>
          )}
          <h3 className="mb-1 mt-5 text-sm text-muted">Recently played</h3>
          <ul className="text-sm">
            {history.data?.items.map((h, i) => (
              <li key={i} className="flex gap-2 py-0.5">
                <span className="w-12 font-display tnum text-faint">
                  {clock(Date.parse(h.started_at), undefined, false)}
                </span>
                <span className="truncate">{trackLine(h)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </>
  );
}
