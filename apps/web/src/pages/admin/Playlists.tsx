import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Plus, Trash2, Wand2 } from "lucide-react";
import { useAuth } from "../../hooks/auth";
import { del, errorMessage, get, patch, post } from "../../lib/api";
import { hourLabel, mmss, trackLine } from "../../lib/format";
import type { Media, Playlist } from "../../lib/types";
import { MediaPicker } from "../../components/console";
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
  Spinner,
  Table,
  Toggle,
  cx,
} from "../../components/ui";

interface PreviewPlan {
  hour: number;
  date: string;
  totalSeconds: number;
  warnings: string[];
  skipped: string | null;
  items: {
    kind: string;
    startSeconds: number;
    length: number;
    artist: string | null;
    title: string | null;
    reason: string;
  }[];
}

export default function Playlists() {
  const { can } = useAuth();
  const manage = can("playlists:manage");
  const qc = useQueryClient();
  const [selected, setSelected] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [picker, setPicker] = useState(false);
  const [previewHour, setPreviewHour] = useState<number | null>(null);
  const list = useQuery({
    queryKey: ["playlists"],
    queryFn: () => get<{ items: Playlist[] }>("/api/playlists"),
  });
  const detail = useQuery({
    queryKey: ["playlist", selected],
    queryFn: () =>
      get<{ playlist: Playlist; items: { media: Media; media_id: number }[] }>(
        `/api/playlists/${selected}`,
      ),
    enabled: selected !== null,
  });
  const preview = useQuery({
    queryKey: ["preview", previewHour],
    queryFn: () =>
      post<{ plans: PreviewPlan[] }>("/api/schedule/generate", {
        hours: [previewHour],
        dryRun: true,
        force: true,
      }),
    enabled: previewHour !== null,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["playlists"] });
    void qc.invalidateQueries({ queryKey: ["playlist", selected] });
  };
  const items = detail.data?.items ?? [];
  const reorder = async (from: number, to: number) => {
    const ids = items.map((i) => i.media_id);
    const [m] = ids.splice(from, 1);
    ids.splice(to, 0, m!);
    await post(`/api/playlists/${selected}/items/reorder`, { mediaIds: ids }).catch((e) =>
      toast.error(errorMessage(e)),
    );
    refresh();
  };
  const hourOf = (name: string) => /^\[PM\] (\d{2}):00$/.exec(name)?.[1];
  const groups: { label: string; items: Playlist[] }[] = [
    { label: "Hours", items: (list.data?.items ?? []).filter((p) => hourOf(p.name)) },
    {
      label: "Decades & general",
      items: (list.data?.items ?? []).filter(
        (p) => !hourOf(p.name) && (p.role === "decade" || p.role === "general"),
      ),
    },
    {
      label: "News, jingles & other",
      items: (list.data?.items ?? []).filter(
        (p) => !hourOf(p.name) && p.role !== "decade" && p.role !== "general",
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Playlists"
        description="Each [PM] HH:00 playlist feeds one hour. Decades and General are the fallback-mode pool; Nieuws holds the news files."
        actions={
          manage ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" /> New playlist
            </Button>
          ) : null
        }
      />
      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <Panel bodyClass="p-2">
          {list.isLoading ? <Spinner /> : null}
          {groups.map((g) => (
            <div key={g.label} className="mb-3">
              <h3 className="px-2 py-1 text-xs text-faint">{g.label}</h3>
              <ul>
                {g.items.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(p.id)}
                      className={cx(
                        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm",
                        selected === p.id ? "bg-panel-2" : "hover:bg-panel-2/60",
                        !p.enabled && "opacity-50",
                      )}
                    >
                      <span className="flex-1 truncate">{p.name}</span>
                      <span className="font-display text-xs tnum text-faint">
                        {p.item_count ?? 0}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Panel>

        <div className="flex flex-col gap-4">
          {!detail.data ? (
            <Empty title="Pick a playlist">
              Choose a playlist on the left to see and order its tracks.
            </Empty>
          ) : (
            <Panel
              title={detail.data.playlist.name}
              actions={
                <>
                  {hourOf(detail.data.playlist.name) ? (
                    <Button
                      size="sm"
                      onClick={() => setPreviewHour(Number(hourOf(detail.data!.playlist.name)))}
                    >
                      <Wand2 className="size-4" /> Preview hour
                    </Button>
                  ) : null}
                  {manage ? (
                    <>
                      <Button size="sm" onClick={() => setPicker(true)}>
                        <Plus className="size-4" /> Add tracks
                      </Button>
                      <Toggle
                        checked={detail.data.playlist.enabled}
                        onChange={async (v) => {
                          await patch(`/api/playlists/${selected}`, { enabled: v }).catch((e) =>
                            toast.error(errorMessage(e)),
                          );
                          refresh();
                        }}
                        label="Enabled"
                      />
                      <ConfirmButton
                        size="sm"
                        onConfirm={async () => {
                          try {
                            await del(`/api/playlists/${selected}`);
                            setSelected(null);
                            refresh();
                            toast.success("Playlist deleted");
                          } catch (e) {
                            toast.error(errorMessage(e));
                          }
                        }}
                      >
                        <Trash2 className="size-4" />
                      </ConfirmButton>
                    </>
                  ) : null}
                </>
              }
              bodyClass="p-0"
            >
              <p className="border-b border-line px-4 py-2 text-sm text-muted">
                <Badge>{detail.data.playlist.role}</Badge> {items.length} tracks ·{" "}
                {mmss(items.reduce((n, i) => n + (i.media.duration ?? 0), 0))} total
              </p>
              {items.length === 0 ? (
                <div className="p-4">
                  <Empty title="No tracks yet">
                    Add tracks from the library, or drop files into a folder with this playlist's
                    name and run a scan.
                  </Empty>
                </div>
              ) : (
                <Table>
                  <tbody>
                    {items.map((i, idx) => (
                      <tr key={i.media_id}>
                        <td className="w-10 font-display tnum text-faint">{idx + 1}</td>
                        <td className="truncate">{trackLine(i.media)}</td>
                        <td className="w-16 text-right font-display tnum text-muted">
                          {mmss(i.media.duration)}
                        </td>
                        {manage ? (
                          <td className="w-28 text-right">
                            <button
                              type="button"
                              className="rounded p-1 hover:bg-panel-2"
                              aria-label="Move up"
                              disabled={idx === 0}
                              onClick={() => reorder(idx, idx - 1)}
                            >
                              <ArrowUp className="size-4" />
                            </button>
                            <button
                              type="button"
                              className="rounded p-1 hover:bg-panel-2"
                              aria-label="Move down"
                              disabled={idx === items.length - 1}
                              onClick={() => reorder(idx, idx + 1)}
                            >
                              <ArrowDown className="size-4" />
                            </button>
                            <button
                              type="button"
                              className="rounded p-1 text-clip hover:bg-panel-2"
                              aria-label="Remove from playlist"
                              onClick={async () => {
                                await del(`/api/playlists/${selected}/items/${i.media_id}`);
                                refresh();
                              }}
                            >
                              <Trash2 className="size-4" />
                            </button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Panel>
          )}
        </div>
      </div>

      <MediaPicker
        open={picker}
        onClose={() => setPicker(false)}
        title="Add to playlist"
        onPick={async (m) => {
          const r = await post<{ added: number }>(`/api/playlists/${selected}/items`, {
            mediaIds: [m.id],
          }).catch((e) => (toast.error(errorMessage(e)), { added: 0 }));
          toast.success(r.added ? `Added ${m.title ?? "track"}` : "Already in this playlist");
          refresh();
        }}
      />

      <Modal
        open={previewHour !== null}
        onClose={() => setPreviewHour(null)}
        title={`Generator preview · ${hourLabel(previewHour ?? 0)}`}
        wide
      >
        {preview.isLoading ? <Spinner label="Generating" /> : null}
        {preview.error ? <p className="text-sm text-clip">{errorMessage(preview.error)}</p> : null}
        {preview.data?.plans.map((p) => (
          <div key={p.hour}>
            <p className="mb-2 text-sm text-muted">
              Dry run, nothing is saved. Total {mmss(p.totalSeconds)}.
            </p>
            {p.warnings.map((w) => (
              <p key={w} className="text-sm text-tally">
                {w}
              </p>
            ))}
            <Table>
              <tbody>
                {p.items.map((i, idx) => (
                  <tr key={idx}>
                    <td className="w-16 font-display tnum text-muted">{mmss(i.startSeconds)}</td>
                    <td>
                      {i.kind === "news" ? <Badge tone="warn">news</Badge> : null}{" "}
                      {i.artist ? `${i.artist} – ` : ""}
                      {i.title}
                    </td>
                    <td className="text-xs text-faint">{i.reason.replace("-", " ")}</td>
                    <td className="w-16 text-right font-display tnum">{mmss(i.length)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        ))}
      </Modal>

      <CreatePlaylist
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          refresh();
          setSelected(id);
        }}
      />
    </>
  );
}

function CreatePlaylist({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<Playlist["role"]>("music");
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} onClose={onClose} title="New playlist">
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const r = await post<{ playlist: Playlist }>("/api/playlists", { name, role });
            toast.success(`Created ${name}`);
            onCreated(r.playlist.id);
            onClose();
          } catch (err) {
            toast.error(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Name">
          {(id) => (
            <Input
              id={id}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={100}
            />
          )}
        </Field>
        <Field label="Role">
          {(id) => (
            <Select
              id={id}
              value={role}
              onChange={(e) => setRole(e.target.value as Playlist["role"])}
            >
              <option value="music">Music</option>
              <option value="general">General</option>
              <option value="decade">Decade</option>
              <option value="jingle">Jingles & stingers</option>
              <option value="news">News</option>
            </Select>
          )}
        </Field>
        <Button type="submit" tone="primary" busy={busy}>
          Create playlist
        </Button>
      </form>
    </Modal>
  );
}
