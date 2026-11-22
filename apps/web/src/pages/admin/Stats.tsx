import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import {
  Bar,
  BarChart,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Legend,
} from "recharts";
import { get } from "../../lib/api";
import { clock, dateTime, mmss } from "../../lib/format";
import { Panel, PageHeader, Select, Table } from "../../components/ui";

const MOUNT_COLORS = ["#ffb020", "#3ecf6e", "#7aa7ff", "#e6e3dc", "#c084fc"];

export default function Stats() {
  const [days, setDays] = useState(7);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const listeners = useQuery({
    queryKey: ["stats-l", days],
    queryFn: () =>
      get<{
        series: { ts: string; mount: string; listeners: number }[];
        peak: number;
        live: number;
      }>(`/api/stats/listeners?since=${since}&bucketMinutes=${days > 2 ? 60 : 15}`),
  });
  const airplay = useQuery({
    queryKey: ["stats-a", days],
    queryFn: () =>
      get<{
        perHour: { hour: string; plays: number }[];
        topTracks: { media_id: number; title: string; artist: string; plays: number }[];
        topArtists: { artist: string; plays: number }[];
        uniqueArtists: number;
        totalPlays: number;
        bySource: Record<string, number>;
        shifts: {
          username: string | null;
          sessions: number;
          total_seconds: number;
          peak_listeners: number;
        }[];
        requests: Record<string, number>;
      }>(`/api/stats/airplay?since=${since}`),
  });
  const mounts = [...new Set((listeners.data?.series ?? []).map((p) => p.mount))];
  const byTs = new Map<string, Record<string, number | string>>();
  for (const p of listeners.data?.series ?? []) {
    const row = byTs.get(p.ts) ?? {
      t: days > 2 ? dateTime(p.ts) : clock(Date.parse(p.ts), undefined, false),
    };
    row[p.mount] = p.listeners;
    byTs.set(p.ts, row);
  }
  const series = [...byTs.values()];
  const a = airplay.data;
  const exportUrl = (type: string) => `/api/stats/export?type=${type}&since=${since}`;

  return (
    <>
      <PageHeader
        title="Stats"
        description="Listeners from Icecast, what aired, and who was live."
        actions={
          <Select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="w-40"
            aria-label="Period"
          >
            <option value={1}>Last 24 hours</option>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </Select>
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        {[
          ["Listening now", listeners.data?.live ?? 0],
          ["Peak", listeners.data?.peak ?? 0],
          ["Plays", a?.totalPlays ?? 0],
          ["Different artists", a?.uniqueArtists ?? 0],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-line bg-panel px-4 py-3">
            <p className="text-sm text-muted">{label}</p>
            <p className="font-display text-3xl font-semibold tnum">{value}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel
          title="Listeners per mount"
          className="xl:col-span-2"
          actions={
            <a
              className="inline-flex items-center gap-1 text-sm text-muted hover:text-legend"
              href={exportUrl("listeners")}
            >
              <Download className="size-4" /> CSV
            </a>
          }
        >
          <div className="h-64">
            <ResponsiveContainer>
              <LineChart data={series} margin={{ left: -20, right: 8 }}>
                <XAxis
                  dataKey="t"
                  stroke="#6b6a65"
                  fontSize={12}
                  tickLine={false}
                  minTickGap={50}
                />
                <YAxis stroke="#6b6a65" fontSize={12} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={{ background: "#252931", border: "1px solid #3a3f49" }} />
                <Legend />
                {mounts.map((m, i) => (
                  <Line
                    key={m}
                    type="monotone"
                    dataKey={m}
                    stroke={MOUNT_COLORS[i % MOUNT_COLORS.length]}
                    dot={false}
                    strokeWidth={2}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel title="Plays by hour of day (UTC)">
          <div className="h-56">
            <ResponsiveContainer>
              <BarChart data={a?.perHour ?? []} margin={{ left: -20 }}>
                <XAxis dataKey="hour" stroke="#6b6a65" fontSize={12} tickLine={false} />
                <YAxis stroke="#6b6a65" fontSize={12} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={{ background: "#252931", border: "1px solid #3a3f49" }} />
                <Bar dataKey="plays" fill="#ffb020" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-2 text-sm text-muted">
            By source:{" "}
            {Object.entries(a?.bySource ?? {})
              .map(([k, v]) => `${k} ${v}`)
              .join(", ") || "–"}{" "}
            · requests played {a?.requests.played ?? 0}
          </p>
        </Panel>
        <Panel
          title="Top tracks"
          actions={
            <a
              className="inline-flex items-center gap-1 text-sm text-muted hover:text-legend"
              href={exportUrl("history")}
            >
              <Download className="size-4" /> Full history CSV
            </a>
          }
        >
          <Table>
            <tbody>
              {a?.topTracks.slice(0, 12).map((t) => (
                <tr key={t.media_id}>
                  <td className="truncate">
                    {t.artist} – {t.title}
                  </td>
                  <td className="w-12 text-right font-display tnum">{t.plays}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>
        <Panel
          title="DJ shifts"
          className="xl:col-span-2"
          actions={
            <a
              className="inline-flex items-center gap-1 text-sm text-muted hover:text-legend"
              href={exportUrl("shifts")}
            >
              <Download className="size-4" /> CSV
            </a>
          }
        >
          {a?.shifts.length ? (
            <Table>
              <thead>
                <tr>
                  <th>DJ</th>
                  <th className="text-right">Sessions</th>
                  <th className="text-right">Time on air</th>
                  <th className="text-right">Peak listeners</th>
                </tr>
              </thead>
              <tbody>
                {a.shifts.map((s, i) => (
                  <tr key={i}>
                    <td>{s.username ?? "unknown"}</td>
                    <td className="text-right font-display tnum">{s.sessions}</td>
                    <td className="text-right font-display tnum">{mmss(s.total_seconds)}</td>
                    <td className="text-right font-display tnum">{s.peak_listeners}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="text-sm text-muted">No live sessions in this period.</p>
          )}
        </Panel>
      </div>
    </>
  );
}
