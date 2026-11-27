/**
 * Library drawer: a song browser docked to the bottom of the screen, over the
 * studio. Search the whole library (more results load as you scroll), filter
 * by playlist, pre-listen, and drag a track onto player A/B or into the queue,
 * or use the row buttons. Closed, only a tab button stays visible. The height
 * (drag the top edge) is remembered in this browser.
 */
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, GripVertical, Headphones, ListPlus, Search } from "lucide-react";
import { get } from "../../lib/api";
import { mmss } from "../../lib/format";
import type { Media, Playlist, StudioPlayerId } from "../../lib/types";
import { command } from "../console";
import { Input, Select, Spinner, cx } from "../ui";
import { startMediaDrag } from "./drag";

const HEIGHT_KEY = "studio-library-height";
const PAGE = 100;
const SORTS = {
  artist: { sort: "artist", order: "asc", label: "Artist" },
  title: { sort: "title", order: "asc", label: "Title" },
  recent: { sort: "created_at", order: "desc", label: "Recently added" },
  duration: { sort: "duration", order: "asc", label: "Shortest first" },
} as const;
type SortKey = keyof typeof SORTS;

const maxHeight = () => Math.round(window.innerHeight * 0.8);
const clampHeight = (h: number) => Math.min(maxHeight(), Math.max(180, h));

export function LibraryDrawer({
  open,
  onOpenChange,
  focusSignal,
  controls,
  loadable,
  onPreview,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Bumped by the studio's Load / Queue / Find buttons: focus the search box. */
  focusSignal: number;
  controls: boolean;
  loadable: Record<StudioPlayerId, boolean>;
  onPreview: (m: Media) => void;
}) {
  const [height, setHeight] = useState(() =>
    clampHeight(Number(localStorage.getItem(HEIGHT_KEY)) || 360),
  );
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [playlistId, setPlaylistId] = useState<number | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("artist");
  // While a track is dragged the drawer fades and lets the pointer through, so the
  // queue rows it covers can take the drop.
  const [dragging, setDragging] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open, focusSignal]);

  const playlists = useQuery({
    queryKey: ["playlists"],
    queryFn: () => get<{ items: Playlist[] }>("/api/playlists"),
    enabled: open,
  });
  const sort = SORTS[sortKey];
  const results = useInfiniteQuery({
    queryKey: ["library-drawer", debounced, playlistId, sortKey],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({
        status: "ok",
        limit: String(PAGE),
        offset: String(pageParam),
        sort: sort.sort,
        order: sort.order,
      });
      if (debounced) p.set("q", debounced);
      if (playlistId) p.set("playlistId", String(playlistId));
      return get<{ items: Media[]; total: number }>(`/api/media?${p}`);
    },
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, page) => n + page.items.length, 0);
      return loaded < last.total && last.items.length > 0 ? loaded : undefined;
    },
    enabled: open,
  });
  const items = results.data?.pages.flatMap((p) => p.items) ?? [];
  const total = results.data?.pages[0]?.total ?? 0;

  const onScroll = (el: HTMLElement) => {
    if (
      el.scrollTop + el.clientHeight > el.scrollHeight - 400 &&
      results.hasNextPage &&
      !results.isFetchingNextPage
    )
      void results.fetchNextPage();
  };

  // Drag the top edge to resize.
  const startResize = (e: PointerEvent<HTMLDivElement>) => {
    const startY = e.clientY;
    const startH = height;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let last = startH;
    const move = (ev: globalThis.PointerEvent) => {
      last = clampHeight(startH + (startY - ev.clientY));
      setHeight(last);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      localStorage.setItem(HEIGHT_KEY, String(last));
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  if (!open) {
    return (
      <>
        {/* Room for the tab, so it never hides the end of the page. */}
        <div className="h-10" aria-hidden />
        <button
          type="button"
          onClick={() => onOpenChange(true)}
          aria-expanded={false}
          aria-controls="studio-library"
          className="fixed bottom-0 right-6 z-[25] flex items-center gap-2 rounded-t-lg border border-b-0 border-line-strong bg-panel-2 px-4 py-2 text-sm font-medium text-legend shadow-[0_-4px_16px_rgb(0_0_0/0.35)] hover:border-tally"
        >
          <ChevronUp className="size-4" aria-hidden /> Library
        </button>
      </>
    );
  }

  return (
    <>
      {/* Lets the page scroll far enough that nothing stays hidden under the drawer. */}
      <div style={{ height }} aria-hidden />
      <section
        id="studio-library"
        aria-label="Library"
        style={{ height }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onOpenChange(false);
        }}
        className={cx(
          "fixed inset-x-0 bottom-0 z-[25] flex flex-col border-t border-line-strong bg-panel shadow-[0_-8px_24px_rgb(0_0_0/0.4)] transition-opacity lg:left-[220px]",
          dragging && "pointer-events-none opacity-20",
        )}
      >
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the library"
          onPointerDown={startResize}
          className="group flex h-2.5 shrink-0 cursor-ns-resize items-center justify-center"
        >
          <span className="h-1 w-12 rounded-full bg-line-strong group-hover:bg-tally" />
        </div>
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 pb-2.5">
          <h2 className="font-display text-lg font-semibold">Library</h2>
          <div className="relative min-w-48 flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-2.5 size-4 text-faint"
              aria-hidden
            />
            <Input
              ref={searchRef}
              type="search"
              placeholder="Artist, title, album or folder"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="pl-9"
              aria-label="Search the library"
            />
          </div>
          <Select
            aria-label="Playlist"
            className="h-9 w-44"
            value={playlistId ?? ""}
            onChange={(e) => setPlaylistId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">All tracks</option>
            {playlists.data?.items.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.item_count !== undefined ? ` (${p.item_count})` : ""}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Sort"
            className="h-9 w-40"
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
          >
            {Object.entries(SORTS).map(([k, s]) => (
              <option key={k} value={k}>
                {s.label}
              </option>
            ))}
          </Select>
          <span className="w-24 text-right text-sm tnum text-muted" aria-live="polite">
            {results.data ? `${total.toLocaleString()} ${total === 1 ? "track" : "tracks"}` : ""}
          </span>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-expanded
            aria-controls="studio-library"
            aria-label="Close the library"
            className="rounded p-1.5 text-muted hover:bg-panel-2 hover:text-legend"
          >
            <ChevronDown className="size-5" />
          </button>
        </header>
        {controls ? (
          <p className="shrink-0 px-4 pt-1.5 text-xs text-faint">
            Drag a track onto player A or B, or between queue items (the library fades while you
            drag, so you can drop on what is under it). Or use the buttons on a row.
          </p>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto" onScroll={(e) => onScroll(e.currentTarget)}>
          {results.isLoading ? <Spinner /> : null}
          <ul className="divide-y divide-line">
            {items.map((m) => (
              <LibraryRow
                key={m.id}
                media={m}
                controls={controls}
                loadable={loadable}
                onPreview={() => onPreview(m)}
                // Next frame: the browser has taken the drag image by then.
                onDragStart={() => requestAnimationFrame(() => setDragging(true))}
                onDragEnd={() => setDragging(false)}
              />
            ))}
          </ul>
          {results.data && items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted">
              {debounced ? `No tracks match “${debounced}”.` : "No tracks here."}
            </p>
          ) : null}
          {results.isFetchingNextPage ? <Spinner label="Loading more" /> : null}
        </div>
      </section>
    </>
  );
}

function LibraryRow({
  media: m,
  controls,
  loadable,
  onPreview,
  onDragStart,
  onDragEnd,
}: {
  media: Media;
  controls: boolean;
  loadable: Record<StudioPlayerId, boolean>;
  onPreview: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const title = m.title || m.relative_path?.split("/").pop() || "Untitled";
  const folder = m.relative_path?.includes("/") ? m.relative_path.split("/")[0] : "";
  const btn =
    "rounded px-1.5 py-1 hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-30";
  return (
    <li
      draggable={controls}
      onDragStart={(e) => {
        startMediaDrag(e, m);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDoubleClick={onPreview}
      className={cx(
        "group flex items-center gap-3 px-4 py-1.5 text-sm hover:bg-panel-2/50",
        controls && "cursor-grab active:cursor-grabbing",
      )}
    >
      {controls ? <GripVertical className="size-4 shrink-0 text-faint" aria-hidden /> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-legend">{title}</span>
        <span className="block truncate text-xs text-muted">{m.artist ?? ""}</span>
      </span>
      <span className="hidden w-48 truncate text-xs text-faint lg:block">{m.album ?? ""}</span>
      <span className="hidden w-24 truncate text-xs text-faint md:block">{folder}</span>
      <span className="w-12 shrink-0 text-right font-display tnum text-muted">
        {mmss(m.duration)}
      </span>
      <span className="flex shrink-0 items-center gap-0.5 opacity-70 group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          type="button"
          className={btn}
          aria-label={`Pre-listen ${title}`}
          title="Pre-listen (or double-click the row)"
          onClick={onPreview}
        >
          <Headphones className="size-4" />
        </button>
        {controls ? (
          <>
            {(["A", "B"] as const).map((p) => (
              <button
                key={p}
                type="button"
                className={cx(btn, "w-7 font-display font-semibold")}
                disabled={!loadable[p]}
                aria-label={`Load ${title} into player ${p}`}
                title={loadable[p] ? `Load into player ${p}` : `Player ${p} is on air`}
                onClick={() =>
                  command(
                    `/api/studio/players/${p}/load`,
                    { mediaId: m.id },
                    "POST",
                    `Loaded into ${p}`,
                  )
                }
              >
                {p}
              </button>
            ))}
            <button
              type="button"
              className={btn}
              aria-label={`Queue ${title} next`}
              title="Queue next"
              onClick={() =>
                command(
                  "/api/playout/queue/insert",
                  { mediaId: m.id, position: "next" },
                  "POST",
                  `Queued ${title} next`,
                )
              }
            >
              <ListPlus className="size-4" />
            </button>
          </>
        ) : null}
      </span>
    </li>
  );
}
