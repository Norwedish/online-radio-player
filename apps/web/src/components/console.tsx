import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Search } from "lucide-react";
import { applyState } from "../hooks/live";
import { api, errorMessage, get } from "../lib/api";
import { mmss, trackLine } from "../lib/format";
import type { Media, NowPlaying, PlayoutState } from "../lib/types";
import { Badge, Button, Input, Modal, Spinner, cx } from "./ui";

/** Sends a playout command, applies the returned state, toasts on error. */
export async function command(
  path: string,
  body?: unknown,
  method = "POST",
  success?: string,
): Promise<boolean> {
  try {
    const res = await api<{ state?: PlayoutState }>(path, { method, body: body ?? {} });
    applyState(res.state);
    if (success) toast.success(success);
    return true;
  } catch (e) {
    toast.error(errorMessage(e));
    return false;
  }
}

export function useTicker(ms = 500): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const KIND_TONE: Record<string, "neutral" | "warn" | "info" | "good" | "bad"> = {
  news: "warn",
  request: "info",
  stinger: "info",
  jingle: "neutral",
  voiceover: "info",
  emergency: "bad",
  live: "bad",
  music: "neutral",
};

export function KindBadge({ kind, source }: { kind: string; source?: string }) {
  if (kind === "music" && source === "request") return <Badge tone="info">request</Badge>;
  if (kind === "music") return null;
  return <Badge tone={KIND_TONE[kind] ?? "neutral"}>{kind}</Badge>;
}

export function NowPlayingCard({
  np,
  paused,
  compact,
}: {
  np: NowPlaying | null;
  paused?: boolean;
  compact?: boolean;
}) {
  const now = useTicker(250);
  if (!np) return <p className="text-muted">Nothing on air.</p>;
  const position = paused ? np.position : Math.min(np.duration, (now - np.startedAt) / 1000);
  const pct = np.duration > 0 ? Math.min(100, (position / np.duration) * 100) : 0;
  const remaining = np.duration - position;
  return (
    <div className="flex gap-4">
      <img
        src={
          np.artworkUrl ??
          (np.mediaId ? `/api/media/${np.mediaId}/artwork` : "/api/media/0/artwork")
        }
        alt=""
        className={cx(
          "shrink-0 rounded-md border border-line object-cover",
          compact ? "size-16" : "size-28",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <KindBadge kind={np.kind} source={np.source} />
          {paused ? <Badge tone="warn">paused</Badge> : null}
        </div>
        <p
          className={cx(
            "truncate font-display font-semibold leading-tight",
            compact ? "text-xl" : "text-3xl",
          )}
        >
          {np.kind === "news" ? np.title || "News" : np.title || "Untitled"}
        </p>
        <p className="truncate text-muted">{np.kind === "news" ? "" : np.artist}</p>
        <div
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-line"
          role="progressbar"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Track progress"
        >
          <div
            className={cx("h-full", remaining < 10 ? "bg-tally" : "bg-legend")}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-1 flex justify-between font-display text-sm tnum text-muted">
          <span>{mmss(position)}</span>
          <span className={remaining < 10 ? "text-tally" : ""}>−{mmss(remaining)}</span>
        </div>
      </div>
    </div>
  );
}

/** Optional quick filters above the search: a playlist (e.g. Nieuws) or everything. */
export interface PickerSource {
  label: string;
  playlistId?: number;
}

/** Library search returning one media row (queue insert, play-now, voice-over, playlists). */
export function MediaPicker({
  open,
  onClose,
  onPick,
  title = "Find a track",
  playlistId,
  sources,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (m: Media) => void;
  title?: string;
  playlistId?: number;
  sources?: PickerSource[];
}) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [sourceIndex, setSourceIndex] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const source = sources?.[sourceIndex] ?? sources?.[0];
  const filterPlaylistId = source?.playlistId ?? playlistId;
  const results = useQuery({
    queryKey: ["media-pick", debounced, filterPlaylistId],
    queryFn: () =>
      get<{ items: Media[] }>(
        `/api/media?status=ok&limit=40${debounced ? `&q=${encodeURIComponent(debounced)}` : ""}${filterPlaylistId ? `&playlistId=${filterPlaylistId}` : ""}`,
      ),
    enabled: open,
  });
  return (
    <Modal open={open} onClose={onClose} title={title} wide>
      <div className="relative mb-3">
        <Search
          className="pointer-events-none absolute left-3 top-2.5 size-4 text-faint"
          aria-hidden
        />
        <Input
          autoFocus
          placeholder="Artist, title, album or folder"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="pl-9"
          aria-label="Search the library"
        />
      </div>
      {sources && sources.length > 1 ? (
        <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Source">
          {sources.map((s, i) => (
            <Button
              key={s.label}
              size="sm"
              tone={i === sourceIndex ? "default" : "ghost"}
              aria-pressed={i === sourceIndex}
              onClick={() => setSourceIndex(i)}
            >
              {s.label}
            </Button>
          ))}
        </div>
      ) : null}
      {results.isLoading ? <Spinner /> : null}
      <ul className="divide-y divide-line">
        {results.data?.items.map((m) => (
          <li key={m.id}>
            <button
              type="button"
              onClick={() => onPick(m)}
              className="flex w-full items-center gap-3 px-2 py-2 text-left hover:bg-panel-2"
            >
              <span className="min-w-0 flex-1 truncate">{trackLine(m)}</span>
              <span className="truncate text-xs text-faint">{m.relative_path?.split("/")[0]}</span>
              <span className="font-display text-sm tnum text-muted">{mmss(m.duration)}</span>
            </button>
          </li>
        ))}
      </ul>
      {results.data && results.data.items.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">No tracks match “{debounced}”.</p>
      ) : null}
      <div className="mt-4 flex justify-end">
        <Button onClick={onClose}>Close</Button>
      </div>
    </Modal>
  );
}
