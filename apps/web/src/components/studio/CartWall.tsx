/**
 * Cart pads: one press fires a jingle/sweeper on top of whatever is on air
 * (automation or the studio players). Pads come from any playlist; the
 * Jingles playlist is the default. Playing pads light up with their remaining time.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Square } from "lucide-react";
import { useLive } from "../../hooks/live";
import { get } from "../../lib/api";
import { mmss } from "../../lib/format";
import type { Media, Playlist, StudioState } from "../../lib/types";
import { command, useTicker } from "../console";
import { Button, Panel, Select, cx } from "../ui";

const KEY = "studio-cart-playlist";

export function CartWall({ carts, controls }: { carts: StudioState["carts"]; controls: boolean }) {
  const playlists = useQuery({
    queryKey: ["playlists"],
    queryFn: () => get<{ items: Playlist[] }>("/api/playlists"),
  });
  const [playlistId, setPlaylistId] = useState<number | null>(() => {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  });
  // Default to the Jingles playlist once the list is known.
  useEffect(() => {
    if (playlistId === null && playlists.data) {
      const jingles = playlists.data.items.find((p) => p.role === "jingle");
      if (jingles) setPlaylistId(jingles.id);
    }
  }, [playlistId, playlists.data]);
  const pads = useQuery({
    queryKey: ["cart-pads", playlistId],
    queryFn: () => get<{ items: { media: Media }[] }>(`/api/playlists/${playlistId}`),
    enabled: playlistId !== null,
  });
  // Cart positions arrive with state updates; advance them locally between updates.
  const receivedAt = useLive((s) => s.receivedAt);
  const now = useTicker(250);
  const drift = carts.length ? Math.max(0, (now - receivedAt) / 1000) : 0;
  const playing = new Map(
    carts.map((c) => [c.mediaId, { ...c, position: Math.min(c.duration, c.position + drift) }]),
  );

  return (
    <Panel
      title="Cart pads"
      actions={
        <>
          <Select
            aria-label="Cart playlist"
            className="h-8 w-40 text-xs"
            value={playlistId ?? ""}
            onChange={(e) => {
              const v = Number(e.target.value);
              setPlaylistId(v);
              localStorage.setItem(KEY, String(v));
            }}
          >
            {playlists.data?.items.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          {controls ? (
            <Button
              size="sm"
              tone="ghost"
              disabled={carts.length === 0}
              onClick={() => command("/api/studio/carts/stop")}
              aria-label="Stop all carts"
            >
              <Square className="size-3.5" fill="currentColor" />
            </Button>
          ) : null}
        </>
      }
    >
      {pads.data?.items.length ? (
        <div className="grid grid-cols-3 gap-2">
          {pads.data.items.slice(0, 24).map(({ media }) => {
            const on = playing.get(media.id);
            const left = on ? Math.max(0, on.duration - on.position) : null;
            return (
              <button
                key={media.id}
                type="button"
                disabled={!controls}
                onClick={() =>
                  on
                    ? command("/api/studio/carts/stop", { uid: on.uid })
                    : command("/api/studio/carts", { mediaId: media.id })
                }
                title={on ? "Playing — press to stop" : "Fire on air"}
                className={cx(
                  "relative overflow-hidden rounded-md border px-2 py-2.5 text-left text-sm transition-colors disabled:cursor-not-allowed",
                  on
                    ? "border-tally bg-tally/15"
                    : "border-line-strong bg-panel-2 hover:border-tally",
                )}
              >
                {on ? (
                  <span
                    className="absolute inset-y-0 left-0 bg-tally/20"
                    style={{ width: `${Math.min(100, (on.position / (on.duration || 1)) * 100)}%` }}
                    aria-hidden
                  />
                ) : null}
                <span className="relative block truncate">{media.title ?? "Cart"}</span>
                <span className="relative font-display text-xs tnum text-faint">
                  {on ? `−${mmss(left)}` : mmss(media.duration)}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-muted">
          {playlistId === null
            ? "Create a Jingles playlist to get cart pads here."
            : "This playlist is empty. Add jingles, sweepers or effects to it."}
        </p>
      )}
    </Panel>
  );
}
