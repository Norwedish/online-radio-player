import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { useAuth } from "../../hooks/auth";
import { del, errorMessage, get, post } from "../../lib/api";
import { dateTime } from "../../lib/format";
import type { EventRow, Playlist } from "../../lib/types";
import {
  Badge,
  Button,
  ConfirmButton,
  Empty,
  Field,
  Input,
  Modal,
  Panel,
  PageHeader,
  Select,
  Table,
} from "../../components/ui";

function localInput(d: Date): string {
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 16);
}

export default function Events() {
  const { can } = useAuth();
  const manage = can("events:manage");
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const events = useQuery({
    queryKey: ["events"],
    queryFn: () =>
      get<{ items: EventRow[] }>(
        `/api/events?from=${new Date(Date.now() - 86_400_000).toISOString()}`,
      ),
    refetchInterval: 15_000,
  });
  const playlists = useQuery({
    queryKey: ["playlists"],
    queryFn: () => get<{ items: Playlist[] }>("/api/playlists"),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["events"] });
  const act = async (path: string, ok: string) => {
    try {
      await post(path);
      toast.success(ok);
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const plName = (id: number | null) => playlists.data?.items.find((p) => p.id === id)?.name ?? "–";

  return (
    <>
      <PageHeader
        title="Events"
        description="Priority slots that take over automation: a playlist block, a single stinger, or a reserved live slot. Higher priority (1–10) wins; a lower one waits until the active event ends."
        actions={
          manage ? (
            <Button tone="primary" onClick={() => setOpen(true)}>
              <Plus className="size-4" /> New event
            </Button>
          ) : null
        }
      />
      <Panel bodyClass="p-0">
        {events.data?.items.length ? (
          <Table>
            <thead>
              <tr>
                <th>Event</th>
                <th>When</th>
                <th>Priority</th>
                <th>Source</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {events.data.items.map((e) => (
                <tr key={e.id}>
                  <td>
                    {e.title} <Badge>{e.type}</Badge>
                  </td>
                  <td className="text-sm">
                    {dateTime(e.start_at)} {e.end_at ? `– ${dateTime(e.end_at)}` : ""}
                  </td>
                  <td className="font-display tnum">{e.priority}</td>
                  <td className="text-sm text-muted">
                    {e.type === "live" ? "Live DJ" : plName(e.playlist_id)}
                  </td>
                  <td>
                    <Badge
                      tone={
                        e.status === "active" ? "bad" : e.status === "done" ? "neutral" : "info"
                      }
                    >
                      {e.status}
                    </Badge>
                  </td>
                  <td className="text-right">
                    {manage ? (
                      <div className="inline-flex gap-2">
                        {e.status === "scheduled" ? (
                          <Button
                            size="sm"
                            onClick={() => act(`/api/events/${e.id}/start`, "Event started")}
                          >
                            Start now
                          </Button>
                        ) : null}
                        {e.status === "active" ? (
                          <Button
                            size="sm"
                            tone="danger"
                            onClick={() =>
                              act(`/api/events/${e.id}/stop`, "Event stopped; automation resumed")
                            }
                          >
                            Stop
                          </Button>
                        ) : null}
                        {e.status !== "active" ? (
                          <ConfirmButton
                            size="sm"
                            tone="ghost"
                            onConfirm={async () => {
                              await del(`/api/events/${e.id}`).catch((err) =>
                                toast.error(errorMessage(err)),
                              );
                              refresh();
                            }}
                          >
                            Delete
                          </ConfirmButton>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <div className="p-4">
            <Empty title="No upcoming events">
              Schedule a special programme, an ad block or a live slot that overrides the hourly
              plan.
            </Empty>
          </div>
        )}
      </Panel>
      <CreateEvent
        open={open}
        onClose={() => setOpen(false)}
        playlists={playlists.data?.items ?? []}
        onCreated={refresh}
      />
    </>
  );
}

function CreateEvent({
  open,
  onClose,
  playlists,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  playlists: Playlist[];
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<EventRow["type"]>("playlist");
  const [start, setStart] = useState(localInput(new Date(Date.now() + 3_600_000)));
  const [end, setEnd] = useState(localInput(new Date(Date.now() + 7_200_000)));
  const [priority, setPriority] = useState(5);
  const [playlistId, setPlaylistId] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} onClose={onClose} title="New event">
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await post("/api/events", {
              title,
              type,
              startAt: new Date(start).toISOString(),
              endAt: end ? new Date(end).toISOString() : null,
              priority,
              playlistId: playlistId === "" ? null : playlistId,
            });
            toast.success(`Scheduled ${title}`);
            onCreated();
            onClose();
          } catch (err) {
            toast.error(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Title">
          {(id) => (
            <Input
              id={id}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={120}
            />
          )}
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Type">
            {(id) => (
              <Select
                id={id}
                value={type}
                onChange={(e) => setType(e.target.value as EventRow["type"])}
              >
                <option value="playlist">Playlist block</option>
                <option value="stinger">Single stinger</option>
                <option value="live">Live slot</option>
              </Select>
            )}
          </Field>
          <Field label="Priority (1–10)">
            {(id) => (
              <Input
                id={id}
                type="number"
                min={1}
                max={10}
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
              />
            )}
          </Field>
          <Field label="Starts">
            {(id) => (
              <Input
                id={id}
                type="datetime-local"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                required
              />
            )}
          </Field>
          <Field label="Ends">
            {(id) => (
              <Input
                id={id}
                type="datetime-local"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            )}
          </Field>
        </div>
        {type !== "live" ? (
          <Field label="Playlist">
            {(id) => (
              <Select
                id={id}
                value={playlistId}
                onChange={(e) => setPlaylistId(e.target.value ? Number(e.target.value) : "")}
                required
              >
                <option value="">Choose a playlist</option>
                {playlists.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        <Button type="submit" tone="primary" busy={busy}>
          Schedule event
        </Button>
      </form>
    </Modal>
  );
}
