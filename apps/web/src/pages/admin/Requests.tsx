import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Link2, Trash2 } from "lucide-react";
import { useAuth } from "../../hooks/auth";
import { useLive } from "../../hooks/live";
import { del, errorMessage, get, patch, post } from "../../lib/api";
import { ago, mmss } from "../../lib/format";
import type { Media, RequestRow } from "../../lib/types";
import { MediaPicker } from "../../components/console";
import {
  Badge,
  Button,
  Empty,
  Input,
  Panel,
  PageHeader,
  Select,
  Spinner,
  Tabs,
  Toggle,
} from "../../components/ui";

type Status = "pending" | "approved" | "played" | "rejected";

export default function Requests() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const tick = useLive((s) => s.requestTick);
  const [status, setStatus] = useState<Status>("pending");
  const [linking, setLinking] = useState<number | null>(null);
  const [pattern, setPattern] = useState("");
  const [matchType, setMatchType] = useState("contains");
  const list = useQuery({
    queryKey: ["requests", status, tick],
    queryFn: () =>
      get<{ items: RequestRow[]; counts: Record<string, number> }>(
        `/api/requests?status=${status}&limit=200`,
      ),
  });
  const blacklist = useQuery({
    queryKey: ["blacklist"],
    queryFn: () =>
      get<{
        items: { id: number; pattern: string; match_type: string }[];
        configPatterns: string[];
      }>("/api/requests/blacklist"),
  });
  const settings = useQuery({
    queryKey: ["settings-requests"],
    queryFn: () => get<{ settings: { key: string; value: unknown }[] }>("/api/settings/requests"),
    enabled: can("settings:view"),
  });
  const autoApprove = Boolean(
    settings.data?.settings.find((s) => s.key === "requests.autoApprove")?.value,
  );
  const refresh = () => void qc.invalidateQueries({ queryKey: ["requests"] });
  const act = async (path: string, ok: string) => {
    try {
      await post(path);
      toast.success(ok);
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <>
      <PageHeader
        title="Requests"
        description="Listener requests wait here for moderation. Approved requests play after the next news; Play next puts them straight after the current track."
        actions={
          can("settings:manage") ? (
            <Toggle
              checked={autoApprove}
              label="Auto-approve library matches"
              onChange={async (v) => {
                try {
                  await patch("/api/settings/requests", { "requests.autoApprove": v });
                  void settings.refetch();
                  toast.success(
                    v
                      ? "Library matches are approved automatically (blacklist still applies)"
                      : "Every request needs approval",
                  );
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            />
          ) : null
        }
      />
      <div className="mb-3">
        <Tabs
          value={status}
          onChange={setStatus}
          tabs={(["pending", "approved", "played", "rejected"] as Status[]).map((s) => ({
            value: s,
            label: `${s[0]!.toUpperCase()}${s.slice(1)} ${list.data?.counts[s] ? `(${list.data.counts[s]})` : ""}`,
          }))}
        />
      </div>
      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        <Panel bodyClass="p-0">
          {list.isLoading ? (
            <div className="p-4">
              <Spinner />
            </div>
          ) : null}
          {list.data?.items.length === 0 ? (
            <div className="p-4">
              <Empty title={status === "pending" ? "No requests waiting" : `No ${status} requests`}>
                Requests come in from the listener page.
              </Empty>
            </div>
          ) : null}
          <ul className="divide-y divide-line">
            {list.data?.items.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {r.media
                      ? `${r.media.artist ?? ""} – ${r.media.title ?? ""}`
                      : `${r.artist ?? "?"} – ${r.title ?? "?"}`}
                    {r.media ? (
                      <span className="ml-2 font-display text-sm tnum text-muted">
                        {mmss(r.media.duration)}
                      </span>
                    ) : (
                      <Badge tone="warn" className="ml-2">
                        not in library
                      </Badge>
                    )}
                  </p>
                  {r.dedication ? <p className="text-sm">For: {r.dedication}</p> : null}
                  {r.message ? <p className="text-sm text-muted">“{r.message}”</p> : null}
                  <p className="text-xs text-faint">
                    {r.display_name ?? "Anonymous"} {r.contact ? `· ${r.contact}` : ""} ·{" "}
                    {ago(r.created_at)}
                  </p>
                </div>
                {status === "pending" ? (
                  <div className="flex flex-wrap gap-2">
                    {r.media ? (
                      <>
                        <Button
                          size="sm"
                          tone="primary"
                          onClick={() =>
                            act(`/api/requests/${r.id}/approve`, "Approved for the next hour")
                          }
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => act(`/api/requests/${r.id}/play-next`, "Playing next")}
                        >
                          Play next
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" onClick={() => setLinking(r.id)}>
                        <Link2 className="size-4" /> Find in library
                      </Button>
                    )}
                    <Button
                      size="sm"
                      tone="danger"
                      onClick={() => act(`/api/requests/${r.id}/reject`, "Rejected")}
                    >
                      Reject
                    </Button>
                  </div>
                ) : (
                  <Badge
                    tone={r.status === "played" ? "good" : r.status === "rejected" ? "bad" : "info"}
                  >
                    {r.status}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Blacklist">
          <p className="mb-3 text-sm text-muted">
            Requests matching these artists or titles are refused, even with auto-approve on.
          </p>
          <form
            className="mb-3 flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await post("/api/requests/blacklist", { pattern, matchType });
                setPattern("");
                void blacklist.refetch();
              } catch (err) {
                toast.error(errorMessage(err));
              }
            }}
          >
            <Input
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="Artist or title"
              minLength={2}
              required
              aria-label="Blacklist pattern"
            />
            <Select
              value={matchType}
              onChange={(e) => setMatchType(e.target.value)}
              className="w-28"
              aria-label="Match type"
            >
              <option value="contains">contains</option>
              <option value="exact">exact</option>
            </Select>
            <Button type="submit">Add</Button>
          </form>
          <ul className="flex flex-col gap-1 text-sm">
            {blacklist.data?.configPatterns.map((p) => (
              <li key={`cfg-${p}`} className="text-muted">
                {p} <span className="text-xs text-faint">(station config)</span>
              </li>
            ))}
            {blacklist.data?.items.map((b) => (
              <li key={b.id} className="flex items-center justify-between">
                <span>
                  {b.pattern} <span className="text-xs text-faint">{b.match_type}</span>
                </span>
                <button
                  type="button"
                  className="rounded p-1 text-clip hover:bg-panel-2"
                  aria-label={`Remove ${b.pattern}`}
                  onClick={async () => {
                    await del(`/api/requests/blacklist/${b.id}`);
                    void blacklist.refetch();
                  }}
                >
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
      <MediaPicker
        open={linking !== null}
        onClose={() => setLinking(null)}
        title="Link the request to a library track"
        onPick={async (m: Media) => {
          try {
            await post(`/api/requests/${linking}/link`, { mediaId: m.id });
            setLinking(null);
            refresh();
          } catch (e) {
            toast.error(errorMessage(e));
          }
        }}
      />
    </>
  );
}
