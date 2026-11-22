import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Eye, Lock, Mic, RefreshCw, Wand2 } from "lucide-react";
import { useAuth } from "../../hooks/auth";
import { useLive } from "../../hooks/live";
import { errorMessage, get, patch, post } from "../../lib/api";
import { dateTime, hourLabel, mmss } from "../../lib/format";
import type { PlanItem, Playlist } from "../../lib/types";
import {
  Badge,
  Button,
  ConfirmButton,
  Field,
  Input,
  Modal,
  Panel,
  PageHeader,
  Select,
  Spinner,
  Table,
  Toggle,
  cx,
} from "../../components/ui";

interface HourRow {
  hour: number;
  slot: { id: number; playlistId: number; playlistName: string; enabled: boolean } | null;
  override: {
    live?: boolean;
    disabled?: boolean;
    locked?: boolean;
    playlistName?: string;
    note?: string;
  };
  plan: {
    id: number;
    status: string;
    totalSeconds: number | null;
    warnings: string[];
    generatedAt: string | null;
  } | null;
  isCurrent: boolean;
}
interface ScheduleResponse {
  date: string;
  timezone: string;
  fallbackMode: boolean;
  hours: HourRow[];
}

function PlanView({ date, hour, onClose }: { date: string; hour: number; onClose: () => void }) {
  const plan = useQuery({
    queryKey: ["plan", date, hour],
    queryFn: () =>
      get<{
        plan: { mode: string | null; pools: string[]; warnings: string[]; total_seconds: number };
        items: PlanItem[];
        boundary: { action: string; deviation_ms: number; occurred_at: string }[];
      }>(`/api/plans/${date}/${hour}`),
  });
  return (
    <Modal open onClose={onClose} title={`${date} · ${hourLabel(hour)}`} wide>
      {plan.isLoading ? <Spinner /> : null}
      {plan.error ? (
        <p className="text-sm text-muted">No plan for this hour yet. Generate it first.</p>
      ) : null}
      {plan.data ? (
        <>
          <p className="mb-3 text-sm text-muted">
            {mmss(plan.data.plan.total_seconds)} total · from{" "}
            {plan.data.plan.pools.join(", ") || "–"}{" "}
            {plan.data.plan.mode === "fallback" ? <Badge tone="warn">fallback mode</Badge> : null}
          </p>
          {plan.data.plan.warnings.length ? (
            <ul className="mb-3 list-disc pl-5 text-sm text-tally">
              {plan.data.plan.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
          <Table>
            <thead>
              <tr>
                <th>At</th>
                <th>Track</th>
                <th className="text-right">Length</th>
              </tr>
            </thead>
            <tbody>
              {plan.data.items.map((i) => (
                <tr key={i.id} className={i.is_locked ? "bg-tally/5" : ""}>
                  <td className="font-display tnum text-muted">{mmss(i.start_seconds)}</td>
                  <td>
                    {i.kind === "news" ? <Badge tone="warn">news</Badge> : null}{" "}
                    {i.artist ? `${i.artist} – ` : ""}
                    {i.title}
                  </td>
                  <td className="text-right font-display tnum">{mmss(i.length)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          {plan.data.boundary.length ? (
            <div className="mt-4">
              <h3 className="mb-1 text-sm text-muted">Boundary decisions</h3>
              <ul className="text-sm">
                {plan.data.boundary.map((b, i) => (
                  <li key={i}>
                    {dateTime(b.occurred_at)} · {b.action.replace("_", " ")} (
                    {(b.deviation_ms / 1000).toFixed(1)} s)
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
    </Modal>
  );
}

export default function Schedule() {
  const { can } = useAuth();
  const manage = can("schedule:manage");
  const qc = useQueryClient();
  const planTick = useLive((s) => s.planTick);
  const [date, setDate] = useState<string>("");
  const [view, setView] = useState<number | null>(null);
  const [edit, setEdit] = useState<HourRow | null>(null);
  const [busy, setBusy] = useState(false);
  const schedule = useQuery({
    queryKey: ["schedule", date, planTick],
    queryFn: () => get<ScheduleResponse>(`/api/schedule${date ? `?date=${date}` : ""}`),
  });
  const playlists = useQuery({
    queryKey: ["playlists"],
    queryFn: () => get<{ items: Playlist[] }>("/api/playlists"),
  });
  const d = schedule.data;

  const refresh = () => qc.invalidateQueries({ queryKey: ["schedule"] });
  const generate = async (hours?: number[]) => {
    setBusy(true);
    try {
      const r = await post<{ plans: { skipped: string | null }[] }>("/api/schedule/generate", {
        date: d?.date,
        hours,
      });
      toast.success(`Generated ${r.plans.filter((p) => !p.skipped).length} plan(s)`);
      void refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Schedule"
        description={`Twenty-four one-hour slots, news locked at :00 and :30. Times are station time (${d?.timezone ?? "…"}).`}
        actions={
          <>
            <Input
              type="date"
              value={date || d?.date || ""}
              onChange={(e) => setDate(e.target.value)}
              aria-label="Schedule date"
              className="w-40"
            />
            {manage ? (
              <>
                <Toggle
                  checked={Boolean(d?.fallbackMode)}
                  label="Fallback mode (decades + news)"
                  onChange={async (v) => {
                    try {
                      await post("/api/schedule/fallback-mode", { enabled: v });
                      toast.success(
                        v
                          ? "Fallback mode on; upcoming hours regenerated"
                          : "Back to the hourly playlists",
                      );
                      void refresh();
                    } catch (e) {
                      toast.error(errorMessage(e));
                    }
                  }}
                />
                <Button tone="primary" busy={busy} onClick={() => generate()}>
                  <Wand2 className="size-4" /> Generate day
                </Button>
              </>
            ) : null}
          </>
        }
      />
      <Panel bodyClass="p-0">
        {!d ? (
          <div className="p-4">
            <Spinner />
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <th className="w-20">Hour</th>
                <th>Programme</th>
                <th>Plan</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {d.hours.map((h) => (
                <tr
                  key={h.hour}
                  className={cx(h.isCurrent && "bg-tally/10", h.override.disabled && "opacity-50")}
                >
                  <td className="font-display text-lg tnum">
                    {h.isCurrent ? (
                      <span
                        className="mr-1.5 inline-block size-2 rounded-full bg-tally align-middle"
                        aria-label="on air"
                      />
                    ) : null}
                    {hourLabel(h.hour)}
                  </td>
                  <td>
                    <span>
                      {h.override.live
                        ? "Live show"
                        : (h.override.playlistName ?? h.slot?.playlistName ?? "–")}
                    </span>
                    <span className="ml-2 inline-flex gap-1">
                      {h.override.live ? (
                        <Badge tone="bad">
                          <Mic className="size-3" /> live
                        </Badge>
                      ) : null}
                      {h.override.locked ? (
                        <Badge>
                          <Lock className="size-3" /> locked
                        </Badge>
                      ) : null}
                      {h.override.disabled ? <Badge>disabled</Badge> : null}
                      {h.override.playlistName ? <Badge tone="info">override</Badge> : null}
                    </span>
                    {h.override.note ? (
                      <p className="text-xs text-faint">{h.override.note}</p>
                    ) : null}
                  </td>
                  <td>
                    {h.plan ? (
                      <span className="text-sm">
                        <span className="font-display tnum">{mmss(h.plan.totalSeconds)}</span>
                        {h.plan.warnings.length ? (
                          <Badge tone="warn" className="ml-2">
                            {h.plan.warnings.length} warning{h.plan.warnings.length > 1 ? "s" : ""}
                          </Badge>
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-sm text-faint">
                        {h.override.live ? "live source" : "not generated"}
                      </span>
                    )}
                  </td>
                  <td className="text-right">
                    <div className="inline-flex gap-1">
                      <Button
                        size="sm"
                        tone="ghost"
                        onClick={() => setView(h.hour)}
                        aria-label={`View plan for ${hourLabel(h.hour)}`}
                      >
                        <Eye className="size-4" />
                      </Button>
                      {manage ? (
                        <>
                          <Button
                            size="sm"
                            tone="ghost"
                            disabled={h.isCurrent}
                            onClick={() => generate([h.hour])}
                            aria-label={`Regenerate ${hourLabel(h.hour)}`}
                            title={
                              h.isCurrent ? "The on-air hour is never rewritten" : "Regenerate"
                            }
                          >
                            <RefreshCw className="size-4" />
                          </Button>
                          <Button size="sm" onClick={() => setEdit(h)}>
                            Edit
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
      {view !== null && d ? (
        <PlanView date={d.date} hour={view} onClose={() => setView(null)} />
      ) : null}
      {edit && d ? (
        <HourEditor
          row={edit}
          date={d.date}
          playlists={playlists.data?.items ?? []}
          onClose={() => setEdit(null)}
          onSaved={refresh}
        />
      ) : null}
    </>
  );
}

function HourEditor({
  row,
  date,
  playlists,
  onClose,
  onSaved,
}: {
  row: HourRow;
  date: string;
  playlists: Playlist[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [slotPlaylist, setSlotPlaylist] = useState(row.slot?.playlistId ?? 0);
  const [override, setOverride] = useState(row.override);
  const [scope, setScope] = useState<"every" | "date">("every");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const clean = Object.fromEntries(
        Object.entries(override).filter(([, v]) => v !== undefined && v !== "" && v !== false),
      );
      await patch(`/api/schedule/${row.hour}`, {
        playlistId: slotPlaylist || undefined,
        override: Object.keys(clean).length ? clean : null,
        date: scope === "date" ? date : undefined,
      });
      toast.success(`Saved ${hourLabel(row.hour)}`);
      onSaved();
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Edit ${hourLabel(row.hour)}`}>
      <div className="flex flex-col gap-4">
        <Field label="Hour playlist (every day)">
          {(id) => (
            <Select
              id={id}
              value={slotPlaylist}
              onChange={(e) => setSlotPlaylist(Number(e.target.value))}
            >
              {playlists.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="rounded-md border border-line p-3">
          <p className="mb-3 text-sm text-muted">Override</p>
          <div className="flex flex-col gap-3">
            <Toggle
              checked={Boolean(override.live)}
              onChange={(v) => setOverride({ ...override, live: v })}
              label="Live hour (no automation plan)"
            />
            <Toggle
              checked={Boolean(override.locked)}
              onChange={(v) => setOverride({ ...override, locked: v })}
              label="Lock the generated plan"
            />
            <Toggle
              checked={Boolean(override.disabled)}
              onChange={(v) => setOverride({ ...override, disabled: v })}
              label="Disable this hour"
            />
            <Field label="Play from another playlist">
              {(id) => (
                <Select
                  id={id}
                  value={override.playlistName ?? ""}
                  onChange={(e) =>
                    setOverride({ ...override, playlistName: e.target.value || undefined })
                  }
                >
                  <option value="">Use the hour playlist</option>
                  {playlists.map((p) => (
                    <option key={p.id} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Public programme name">
              {(id) => (
                <Input
                  id={id}
                  maxLength={200}
                  value={override.note ?? ""}
                  onChange={(e) => setOverride({ ...override, note: e.target.value })}
                  placeholder="e.g. Saturday Night Classics"
                />
              )}
            </Field>
            <Select
              value={scope}
              onChange={(e) => setScope(e.target.value as "every" | "date")}
              aria-label="Override scope"
            >
              <option value="every">Override every day</option>
              <option value="date">Override only {date}</option>
            </Select>
          </div>
        </div>
        <div className="flex justify-between">
          <ConfirmButton tone="ghost" onConfirm={() => setOverride({})}>
            Clear override
          </ConfirmButton>
          <div className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button tone="primary" busy={busy} onClick={save}>
              Save hour
            </Button>
          </div>
        </div>
        <p className="text-xs text-faint">
          Regenerate the hour afterwards so the plan follows the change. The on-air hour is never
          rewritten.
        </p>
      </div>
    </Modal>
  );
}
