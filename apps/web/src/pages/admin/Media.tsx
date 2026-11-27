import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Crosshair, FolderSearch, Search, Sparkles, Upload } from "lucide-react";
import { useAuth } from "../../hooks/auth";
import { useLive } from "../../hooks/live";
import { errorMessage, get, patch, post, upload } from "../../lib/api";
import { bytes, mmss, trackLine } from "../../lib/format";
import type { Media } from "../../lib/types";
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
  Tabs,
  Toggle,
} from "../../components/ui";

type Tab = "library" | "duplicates" | "suggestions";
const PAGE = 50;

export default function MediaLibrary() {
  const { can } = useAuth();
  const manage = can("media:manage");
  const qc = useQueryClient();
  const mediaTick = useLive((s) => s.mediaTick);
  const [tab, setTab] = useState<Tab>("library");
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState("");
  const [missingTags, setMissingTags] = useState(false);
  const [sort, setSort] = useState("artist");
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<number | null>(null);
  const [uploads, setUploads] = useState<{ name: string; pct: number; error?: string }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(q);
      setPage(0);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const params = new URLSearchParams({
    limit: String(PAGE),
    offset: String(page * PAGE),
    sort,
    ...(debounced ? { q: debounced } : {}),
    ...(status ? { status } : {}),
    ...(missingTags ? { missingTags: "true" } : {}),
  });
  const list = useQuery({
    queryKey: ["media", params.toString(), mediaTick],
    queryFn: () => get<{ items: Media[]; total: number }>(`/api/media?${params}`),
  });
  const stats = useQuery({
    queryKey: ["media-stats", mediaTick],
    queryFn: () =>
      get<{
        byStatus: Record<string, number>;
        total: number;
        scanRunning: boolean;
        watcher: { watching: string[]; imported: number; lastImportAt: string | null };
      }>("/api/media/stats"),
    refetchInterval: 10_000,
  });
  const dupes = useQuery({
    queryKey: ["dupes", mediaTick],
    queryFn: () =>
      get<{ groups: { kind: "hash" | "metadata"; key: string; items: Media[] }[] }>(
        "/api/media/duplicates",
      ),
    enabled: tab === "duplicates",
  });
  const suggestions = useQuery({
    queryKey: ["suggestions", mediaTick],
    queryFn: () =>
      get<{
        items: {
          id: number;
          media_id: number;
          payload: {
            title: string;
            artist: string;
            album: string | null;
            year: number | null;
            score: number;
          };
        }[];
      }>("/api/media/suggestions"),
    enabled: tab === "suggestions",
  });
  const refresh = () =>
    void qc.invalidateQueries({
      predicate: (k) =>
        ["media", "media-stats", "dupes", "suggestions"].includes(String(k.queryKey[0])),
    });

  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      setUploads((u) => [...u, { name: file.name, pct: 0 }]);
      try {
        await upload(`/api/media/upload`, file, (pct) =>
          setUploads((u) => u.map((x) => (x.name === file.name ? { ...x, pct } : x))),
        );
        setUploads((u) => u.map((x) => (x.name === file.name ? { ...x, pct: 100 } : x)));
      } catch (e) {
        setUploads((u) =>
          u.map((x) => (x.name === file.name ? { ...x, error: errorMessage(e) } : x)),
        );
      }
    }
    refresh();
  };

  return (
    <>
      <PageHeader
        title="Media library"
        description={
          stats.data
            ? `${stats.data.total} files · ${stats.data.byStatus.ok ?? 0} playable · ${stats.data.byStatus.missing ?? 0} missing · ${stats.data.byStatus.error ?? 0} unreadable`
            : undefined
        }
        actions={
          manage ? (
            <>
              <Button
                busy={stats.data?.scanRunning}
                onClick={async () => {
                  try {
                    await post("/api/media/import");
                    toast.success("Scan started");
                    setTimeout(refresh, 1500);
                  } catch (e) {
                    toast.error(errorMessage(e));
                  }
                }}
              >
                <FolderSearch className="size-4" /> Scan folders
              </Button>
              <Button
                disabled={busy === "autocue"}
                title="Re-detect cue-in, cue-out and crossfades for every analysed track (keeps manual points)"
                onClick={async () => {
                  setBusy("autocue");
                  try {
                    const r = await post<{ updated: number; skipped: number }>(
                      "/api/media/autocue/recompute",
                      {},
                    );
                    toast.success(
                      `Cue points updated: ${r.updated}${r.skipped ? ` · ${r.skipped} unchanged` : ""}`,
                    );
                    refresh();
                  } catch (e) {
                    toast.error(errorMessage(e));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                <Sparkles className="size-4" />{" "}
                {busy === "autocue" ? "Detecting…" : "Re-detect cues"}
              </Button>
              <Button tone="primary" onClick={() => fileRef.current?.click()}>
                <Upload className="size-4" /> Upload
              </Button>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept=".mp3,.flac,.m4a,.aac,.ogg,.opus,.wav,audio/*"
                className="hidden"
                onChange={(e) => void onFiles(e.target.files)}
              />
            </>
          ) : null
        }
      />
      {uploads.length ? (
        <Panel
          title="Uploads"
          className="mb-4"
          actions={
            <Button size="sm" tone="ghost" onClick={() => setUploads([])}>
              Clear
            </Button>
          }
        >
          <ul className="flex flex-col gap-2 text-sm">
            {uploads.map((u) => (
              <li key={u.name} className="flex items-center gap-3">
                <span className="w-64 truncate">{u.name}</span>
                {u.error ? (
                  <span className="text-clip">{u.error}</span>
                ) : (
                  <span className="h-1.5 flex-1 overflow-hidden rounded bg-line">
                    <span className="block h-full bg-tally" style={{ width: `${u.pct}%` }} />
                  </span>
                )}
                <span className="w-10 text-right font-display tnum">
                  {u.error ? "" : `${u.pct}%`}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
      <div className="mb-3">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "library", label: "Library" },
            { value: "duplicates", label: "Duplicates" },
            { value: "suggestions", label: "Metadata suggestions" },
          ]}
        />
      </div>

      {tab === "library" ? (
        <Panel bodyClass="p-0">
          <div className="flex flex-wrap items-center gap-3 border-b border-line p-3">
            <div className="relative min-w-60 flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-2.5 size-4 text-faint"
                aria-hidden
              />
              <Input
                className="pl-9"
                placeholder="Search artist, title, album or folder"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label="Search media"
              />
            </div>
            <Select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(0);
              }}
              className="w-40"
              aria-label="Status filter"
            >
              <option value="">Any status</option>
              <option value="ok">Playable</option>
              <option value="missing">Missing</option>
              <option value="error">Unreadable</option>
              <option value="disabled">Disabled</option>
            </Select>
            <Select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="w-40"
              aria-label="Sort"
            >
              <option value="artist">Sort by artist</option>
              <option value="title">Sort by title</option>
              <option value="duration">Sort by length</option>
              <option value="loudness_lufs">Sort by loudness</option>
              <option value="created_at">Sort by date added</option>
            </Select>
            <Toggle
              checked={missingTags}
              onChange={(v) => {
                setMissingTags(v);
                setPage(0);
              }}
              label="Missing tags only"
            />
          </div>
          {list.isLoading ? (
            <div className="p-4">
              <Spinner />
            </div>
          ) : list.data?.items.length ? (
            <Table>
              <thead>
                <tr>
                  <th>Track</th>
                  <th className="hidden md:table-cell">Album</th>
                  <th className="hidden lg:table-cell">Folder</th>
                  <th className="text-right">Length</th>
                  <th className="hidden text-right sm:table-cell">Loudness</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((m) => (
                  <tr
                    key={m.id}
                    className="cursor-pointer hover:bg-panel-2"
                    onClick={() => setEditing(m.id)}
                    onKeyDown={(e) => e.key === "Enter" && setEditing(m.id)}
                    tabIndex={0}
                  >
                    <td className="max-w-80 truncate">{trackLine(m)}</td>
                    <td className="hidden max-w-48 truncate text-muted md:table-cell">{m.album}</td>
                    <td className="hidden max-w-40 truncate text-faint lg:table-cell">
                      {m.relative_path?.split("/").slice(0, -1).join("/")}
                    </td>
                    <td className="text-right font-display tnum">{mmss(m.duration)}</td>
                    <td className="hidden text-right font-display tnum text-muted sm:table-cell">
                      {m.loudness_lufs !== null && m.loudness_lufs > -100
                        ? `${m.loudness_lufs.toFixed(1)} LUFS`
                        : "–"}
                    </td>
                    <td>
                      {m.status === "ok" ? (
                        m.tags.tagsMissing ? (
                          <Badge tone="warn">tags missing</Badge>
                        ) : (
                          <Badge tone="good">ok</Badge>
                        )
                      ) : (
                        <Badge tone={m.status === "disabled" ? "neutral" : "bad"}>{m.status}</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <div className="p-4">
              <Empty title={debounced ? "Nothing matches" : "The library is empty"}>
                {debounced
                  ? "Try another search."
                  : "Upload files or put them in the media folder and run a scan."}
              </Empty>
            </div>
          )}
          {list.data && list.data.total > PAGE ? (
            <div className="flex items-center justify-between border-t border-line p-3 text-sm text-muted">
              <span>
                {page * PAGE + 1}–{Math.min(list.data.total, (page + 1) * PAGE)} of{" "}
                {list.data.total}
              </span>
              <div className="flex gap-2">
                <Button size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Button
                  size="sm"
                  disabled={(page + 1) * PAGE >= list.data.total}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null}
        </Panel>
      ) : null}

      {tab === "duplicates" ? (
        <div className="flex flex-col gap-3">
          {dupes.isLoading ? <Spinner /> : null}
          {dupes.data?.groups.length === 0 ? (
            <Empty title="No duplicates found">
              Identical files (same content) and near matches (same artist and title, within 2 s)
              show up here.
            </Empty>
          ) : null}
          {dupes.data?.groups.map((g) => (
            <Panel
              key={`${g.kind}:${g.key}`}
              title={g.kind === "hash" ? "Identical files" : "Same artist and title"}
              actions={
                manage ? (
                  <Button
                    size="sm"
                    tone="ghost"
                    onClick={async () => {
                      await post("/api/media/duplicates/ignore", { kind: g.kind, key: g.key });
                      refresh();
                    }}
                  >
                    Not duplicates
                  </Button>
                ) : null
              }
            >
              <ul className="flex flex-col gap-2 text-sm">
                {g.items.map((m) => (
                  <li key={m.id} className="flex items-center gap-3">
                    <span className="min-w-0 flex-1 truncate">
                      {trackLine(m)} <span className="text-faint">· {m.relative_path}</span>
                    </span>
                    <span className="font-display tnum text-muted">
                      {mmss(m.duration)} · {m.bitrate ?? "?"} kbps
                    </span>
                    {manage ? (
                      <ConfirmButton
                        size="sm"
                        tone="default"
                        confirmLabel="Keep this one?"
                        onConfirm={async () => {
                          await post("/api/media/duplicates/merge", {
                            keepId: m.id,
                            removeIds: g.items.filter((x) => x.id !== m.id).map((x) => x.id),
                          });
                          toast.success("Merged; the others are disabled");
                          refresh();
                        }}
                      >
                        Keep
                      </ConfirmButton>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Panel>
          ))}
        </div>
      ) : null}

      {tab === "suggestions" ? (
        <Panel bodyClass="p-0">
          {suggestions.data?.items.length ? (
            <Table>
              <tbody>
                {suggestions.data.items.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <button
                        type="button"
                        className="text-left hover:underline"
                        onClick={() => setEditing(s.media_id)}
                      >
                        {s.payload.artist} – {s.payload.title}
                      </button>
                      <p className="text-xs text-faint">
                        {[s.payload.album, s.payload.year].filter(Boolean).join(", ")} · match{" "}
                        {s.payload.score}%
                      </p>
                    </td>
                    <td className="text-right">
                      {manage ? (
                        <div className="inline-flex gap-2">
                          <Button
                            size="sm"
                            tone="primary"
                            onClick={async () => {
                              await post(`/api/media/suggestions/${s.id}/apply`);
                              refresh();
                            }}
                          >
                            Apply
                          </Button>
                          <Button
                            size="sm"
                            onClick={async () => {
                              await post(`/api/media/suggestions/${s.id}/reject`);
                              refresh();
                            }}
                          >
                            Reject
                          </Button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <div className="p-4">
              <Empty title="No suggestions waiting">
                Open a track and choose “Look up on MusicBrainz” to get tag suggestions you can
                review here.
              </Empty>
            </div>
          )}
        </Panel>
      ) : null}

      {editing !== null ? (
        <MediaEditor
          id={editing}
          manage={manage}
          onClose={() => setEditing(null)}
          onChanged={refresh}
        />
      ) : null}
    </>
  );
}

function num(v: string): number | null {
  return v === "" ? null : Number(v);
}

function MediaEditor({
  id,
  manage,
  onClose,
  onChanged,
}: {
  id: number;
  manage: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const detail = useQuery({
    queryKey: ["media-item", id],
    queryFn: () =>
      get<{ media: Media; playlists: { id: number; name: string }[] }>(`/api/media/${id}`),
  });
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const artRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLAudioElement>(null);
  const m = detail.data?.media;
  /** Automatic cue points come from loudness analysis; manual ones stay pinned. */
  const isAuto = m ? m.cue_source !== "manual" : true;
  const detected = (() => {
    try {
      return m?.autocue_json
        ? (JSON.parse(m.autocue_json) as {
            cueIn: number;
            cueOut: number;
            fadeIn: number;
            fadeOut: number;
          })
        : null;
    } catch {
      return null;
    }
  })();
  /** Switches between detected and pinned cue points (auto re-runs from the stored envelope). */
  const switchSource = async (auto: boolean) => {
    if (!m) return;
    setBusy("source");
    try {
      if (auto) {
        try {
          await patch(`/api/media/${m.id}`, { cue_source: "auto" });
        } catch {
          // No envelope yet: run the analysis and adopt its result.
          await post(`/api/media/${m.id}/analyze`, { adopt: true });
        }
        toast.success("Automatic cue points applied");
      } else {
        await patch(`/api/media/${m.id}`, { cue_source: "manual" });
        toast.success("Cue points pinned as manual");
      }
      await detail.refetch();
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  /** Sets a marker field from where the preview player is now (mark intros by ear). */
  const markHere = (k: string) => {
    const t = previewRef.current?.currentTime;
    if (t === undefined) return;
    setForm((f) => ({ ...f, [k]: (Math.round(t * 10) / 10).toString() }));
  };
  useEffect(() => {
    if (!m) return;
    setForm({
      title: m.title ?? "",
      artist: m.artist ?? "",
      album: m.album ?? "",
      genre: m.genre ?? "",
      year: m.year?.toString() ?? "",
      cue_in: m.cue_in?.toString() ?? "",
      cue_out: m.cue_out?.toString() ?? "",
      intro_end: m.intro_end?.toString() ?? "",
      outro_start: m.outro_start?.toString() ?? "",
      fade_in: m.fade_in?.toString() ?? "",
      fade_out: m.fade_out?.toString() ?? "",
      gain_db: m.gain_db?.toString() ?? "",
    });
  }, [m]);
  const set = (k: string) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const run = async (label: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(label);
    try {
      await fn();
      toast.success(ok);
      void detail.refetch();
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Modal open onClose={onClose} title={m ? trackLine(m) : "Track"} wide>
      {!m ? (
        <Spinner />
      ) : (
        <div className="grid gap-5 md:grid-cols-[160px_1fr]">
          <div className="flex flex-col gap-2">
            <img
              src={`/api/media/${m.id}/artwork?v=${m.artwork_path ?? ""}`}
              alt="Artwork"
              className="aspect-square w-full rounded-md border border-line object-cover"
            />
            {manage ? (
              <>
                <Button size="sm" onClick={() => artRef.current?.click()}>
                  Replace artwork
                </Button>
                <input
                  ref={artRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(e) =>
                    e.target.files?.[0] &&
                    run(
                      "art",
                      () =>
                        upload(`/api/media/${m.id}/artwork`, e.target.files![0]!, () => {}, "PUT"),
                      "Artwork updated",
                    )
                  }
                />
              </>
            ) : null}
            <audio
              ref={previewRef}
              controls
              preload="none"
              src={`/api/media/${m.id}/preview`}
              className="w-full"
              aria-label="Preview"
            />
          </div>
          <div className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              {(["title", "artist", "album", "genre"] as const).map((k) => (
                <Field key={k} label={k[0]!.toUpperCase() + k.slice(1)}>
                  {(fid) => (
                    <Input id={fid} value={form[k] ?? ""} onChange={set(k)} disabled={!manage} />
                  )}
                </Field>
              ))}
              <Field label="Year">
                {(fid) => (
                  <Input
                    id={fid}
                    inputMode="numeric"
                    value={form.year ?? ""}
                    onChange={set("year")}
                    disabled={!manage}
                  />
                )}
              </Field>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Badge tone={isAuto ? "good" : "neutral"}>
                {isAuto ? "Automatic cue points" : "Manual cue points"}
              </Badge>
              {manage ? (
                <Button
                  size="sm"
                  tone="ghost"
                  busy={busy === "source"}
                  onClick={() => switchSource(!isAuto)}
                >
                  <Sparkles className="size-3.5" />
                  {isAuto ? "Set cue points manually" : "Detect again automatically"}
                </Button>
              ) : null}
            </div>
            <p className="-mt-2 text-xs text-faint">
              Automatic points follow the volume: playback starts when the track gets loud and the
              next song begins where the outro drops away, so songs crossfade instead of stopping.
              Set them manually to keep your own points.
            </p>
            <div className="grid gap-3 sm:grid-cols-4">
              {(
                [
                  ["cue_in", "Cue in (s)"],
                  ["intro_end", "Intro end (s)"],
                  ["outro_start", "Outro start (s)"],
                  ["cue_out", "Cue out (s)"],
                ] as const
              ).map(([k, label]) => {
                const locked = isAuto && (k === "cue_in" || k === "cue_out");
                return (
                  <Field key={k} label={label}>
                    {(fid) => (
                      <div className="flex gap-1">
                        <Input
                          id={fid}
                          inputMode="decimal"
                          value={form[k] ?? ""}
                          onChange={set(k)}
                          disabled={!manage || locked}
                          className="min-w-0 flex-1"
                        />
                        {manage && !locked ? (
                          <Button
                            size="sm"
                            tone="ghost"
                            className="h-9 px-2"
                            onClick={() => markHere(k)}
                            title="Set from the preview player's position"
                            aria-label={`Set ${label} from preview position`}
                          >
                            <Crosshair className="size-4" />
                          </Button>
                        ) : null}
                      </div>
                    )}
                  </Field>
                );
              })}
            </div>
            <p className="-mt-2 text-xs text-faint">
              Intro and outro drive the studio player timers. Play the preview and press the
              crosshair to mark a point.
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Fade in">
                {(fid) => (
                  <Input
                    id={fid}
                    inputMode="decimal"
                    value={form.fade_in ?? ""}
                    onChange={set("fade_in")}
                    disabled={!manage || isAuto}
                  />
                )}
              </Field>
              <Field label="Fade out">
                {(fid) => (
                  <Input
                    id={fid}
                    inputMode="decimal"
                    value={form.fade_out ?? ""}
                    onChange={set("fade_out")}
                    disabled={!manage || isAuto}
                  />
                )}
              </Field>
              <Field label="Gain (dB)">
                {(fid) => (
                  <Input
                    id={fid}
                    inputMode="decimal"
                    value={form.gain_db ?? ""}
                    onChange={set("gain_db")}
                    disabled={!manage}
                  />
                )}
              </Field>
            </div>
            {detected ? (
              <p className="-mt-2 text-xs text-faint tnum">
                Detected: cue in {detected.cueIn.toFixed(1)} s · cue out{" "}
                {detected.cueOut.toFixed(1)} s · fade in {detected.fadeIn.toFixed(1)} s · crossfade{" "}
                {detected.fadeOut.toFixed(1)} s
              </p>
            ) : null}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
              <dt className="text-muted">Length</dt>
              <dd className="font-display tnum">{mmss(m.duration)}</dd>
              <dt className="text-muted">Loudness</dt>
              <dd className="font-display tnum">
                {m.loudness_lufs !== null && m.loudness_lufs > -100
                  ? `${m.loudness_lufs.toFixed(1)} LUFS / ${m.peak_db?.toFixed(1)} dBTP`
                  : "not measured"}
              </dd>
              <dt className="text-muted">Format</dt>
              <dd>
                {m.codec} {m.bitrate ? `${m.bitrate} kbps` : ""}
              </dd>
              <dt className="text-muted">Size</dt>
              <dd>{bytes(m.size)}</dd>
              <dt className="text-muted">Playlists</dt>
              <dd className="col-span-3">
                {detail.data?.playlists.map((p) => p.name).join(", ") || "none"}
              </dd>
              <dt className="text-muted">File</dt>
              <dd className="col-span-3 truncate text-faint">{m.relative_path}</dd>
            </dl>
            {manage ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  tone="primary"
                  busy={busy === "save"}
                  onClick={() =>
                    run(
                      "save",
                      () =>
                        patch(`/api/media/${m.id}`, {
                          title: form.title || null,
                          artist: form.artist || null,
                          album: form.album || null,
                          genre: form.genre || null,
                          year: num(form.year ?? ""),
                          cue_in: num(form.cue_in ?? ""),
                          cue_out: num(form.cue_out ?? ""),
                          intro_end: num(form.intro_end ?? ""),
                          outro_start: num(form.outro_start ?? ""),
                          fade_in: num(form.fade_in ?? ""),
                          fade_out: num(form.fade_out ?? ""),
                          gain_db: num(form.gain_db ?? ""),
                        }),
                      "Saved",
                    )
                  }
                >
                  Save changes
                </Button>
                <Button
                  busy={busy === "analyze"}
                  onClick={() =>
                    run("analyze", () => post(`/api/media/${m.id}/analyze`), "Loudness measured")
                  }
                >
                  Measure loudness
                </Button>
                <Button
                  busy={busy === "lookup"}
                  onClick={() =>
                    run(
                      "lookup",
                      () => post(`/api/media/${m.id}/lookup`),
                      "Suggestions added to the review tab",
                    )
                  }
                >
                  Look up on MusicBrainz
                </Button>
                <Button
                  onClick={() =>
                    run(
                      "status",
                      () =>
                        patch(`/api/media/${m.id}`, {
                          status: m.status === "disabled" ? "ok" : "disabled",
                        }),
                      m.status === "disabled" ? "Enabled" : "Disabled",
                    )
                  }
                >
                  {m.status === "disabled" ? "Enable" : "Disable"}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </Modal>
  );
}
