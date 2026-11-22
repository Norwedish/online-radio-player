import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "../../hooks/auth";
import { useLive } from "../../hooks/live";
import { errorMessage, get, post } from "../../lib/api";
import { dateTime } from "../../lib/format";
import type { Alert } from "../../lib/types";
import {
  Badge,
  Button,
  Empty,
  Panel,
  PageHeader,
  Select,
  Spinner,
  Tabs,
  severityTone,
} from "../../components/ui";

export default function Alerts() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const tick = useLive((s) => s.alertTick);
  const [view, setView] = useState<"active" | "all">("active");
  const [severity, setSeverity] = useState("");
  const list = useQuery({
    queryKey: ["alerts", view, severity, tick],
    queryFn: () =>
      get<{ items: Alert[]; total: number }>(
        `/api/alerts?limit=200${view === "active" ? "&active=true" : ""}${severity ? `&severity=${severity}` : ""}`,
      ),
  });
  const ack = async (id: number) => {
    try {
      await post(`/api/alerts/${id}/ack`);
      void qc.invalidateQueries({ predicate: (k) => String(k.queryKey[0]).startsWith("alerts") });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <>
      <PageHeader
        title="Alerts"
        description="Dead air, encoder and Stereo Tool failures, Icecast loss, live no-shows, generator gaps, backups and disk space."
        actions={
          <>
            <Select
              value={severity}
              onChange={(e) => setSeverity(e.target.value)}
              className="w-36"
              aria-label="Severity filter"
            >
              <option value="">All severities</option>
              <option value="critical">Critical</option>
              <option value="error">Error</option>
              <option value="warning">Warning</option>
              <option value="info">Info</option>
            </Select>
            {can("settings:manage") ? (
              <Button
                onClick={async () => {
                  try {
                    await post("/api/alerts/test", { severity: "error" });
                    toast.success("Test alert sent to every configured channel");
                  } catch (e) {
                    toast.error(errorMessage(e));
                  }
                }}
              >
                Send test alert
              </Button>
            ) : null}
          </>
        }
      />
      <div className="mb-3">
        <Tabs
          value={view}
          onChange={setView}
          tabs={[
            { value: "active", label: "Open" },
            { value: "all", label: "History" },
          ]}
        />
      </div>
      <Panel bodyClass="p-0">
        {list.isLoading ? (
          <div className="p-4">
            <Spinner />
          </div>
        ) : null}
        {list.data?.items.length === 0 ? (
          <div className="p-4">
            <Empty title={view === "active" ? "All clear" : "No alerts yet"}>
              New alerts also appear as a toast and in the sidebar count.
            </Empty>
          </div>
        ) : null}
        <ul className="divide-y divide-line">
          {list.data?.items.map((a) => (
            <li key={a.id} className="flex flex-wrap items-start gap-3 p-4">
              <Badge tone={severityTone(a.severity)}>{a.severity}</Badge>
              <div className="min-w-0 flex-1">
                <p>{a.message}</p>
                <p className="text-xs text-faint">
                  {a.type} · {dateTime(a.created_at)}
                  {a.acknowledged_at ? ` · acknowledged ${dateTime(a.acknowledged_at)}` : ""}
                  {a.resolved_at ? ` · resolved ${dateTime(a.resolved_at)}` : ""}
                </p>
                {a.details && Object.keys(a.details).length ? (
                  <details className="mt-1 text-xs text-muted">
                    <summary className="cursor-pointer">Details</summary>
                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap">
                      {JSON.stringify(a.details, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </div>
              {!a.acknowledged_at && can("alerts:ack") ? (
                <Button size="sm" onClick={() => ack(a.id)}>
                  Acknowledge
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}
