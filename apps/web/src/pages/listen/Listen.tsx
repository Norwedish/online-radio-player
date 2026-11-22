/**
 * Public listener page (PLAN §5.8 / M11.1–M11.3): station-branded player with
 * MP3/Opus/AAC and an HLS fallback, now playing, next up, recently played and
 * the request form with live status.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { api, errorMessage, get } from "../../lib/api";
import { clock } from "../../lib/format";

interface NowPlayingResponse {
  station: {
    name: string;
    timezone?: string;
    logoUrl: string | null;
    colors: Record<string, string>;
  };
  nowPlaying: {
    title: string;
    artist: string;
    kind: string;
    artworkUrl: string | null;
    startedAt: string;
    duration: number;
    isRequest: boolean;
  } | null;
  next: { title: string; artist: string; kind: string }[];
  live: { active: boolean; dj: string | null };
  listeners: number;
  onAir: boolean;
  streams: {
    mounts: {
      mount: string;
      url: string;
      codec: string;
      bitrate: string;
      contentType: string;
      primary: boolean;
    }[];
    hls: string | null;
  };
}

type PlayerState = "idle" | "connecting" | "playing" | "buffering" | "error";

function readRequests(): number[] {
  try {
    return JSON.parse(localStorage.getItem("radio-requests") ?? "[]") as number[];
  } catch {
    return [];
  }
}
function writeRequests(ids: number[]): void {
  try {
    localStorage.setItem("radio-requests", JSON.stringify(ids.slice(-5)));
  } catch {
    // storage unavailable (private mode): status is still shown for this visit
  }
}

export function useNowPlaying() {
  const q = useQuery({
    queryKey: ["np"],
    queryFn: () => get<NowPlayingResponse>("/api/public/now-playing"),
    refetchInterval: 15_000,
  });
  const { refetch } = q;
  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    let ws: WebSocket | null = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (e) => {
      try {
        if ((JSON.parse(String(e.data)) as { type: string }).type === "public:now-playing")
          void refetch();
      } catch {
        // ignore
      }
    };
    ws.onerror = () => ws?.close();
    return () => {
      ws?.close();
      ws = null;
    };
  }, [refetch]);
  return q;
}

export function brandStyle(colors: Record<string, string> | undefined): CSSProperties {
  return {
    "--brand": colors?.primary ?? "#ffb020",
    "--brand-bg": colors?.background ?? "#16181c",
  } as CSSProperties;
}

export default function Listen() {
  const np = useNowPlaying();
  const d = np.data;
  const history = useQuery({
    queryKey: ["hist", d?.nowPlaying?.startedAt],
    queryFn: () =>
      get<{
        items: { title: string; artist: string; startedAt: string; artworkUrl: string | null }[];
      }>("/api/public/history?limit=8"),
  });
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const hlsRef = useRef<{ destroy(): void } | null>(null);
  const [player, setPlayer] = useState<PlayerState>("idle");
  const [mount, setMount] = useState<string>("");
  const [volume, setVolume] = useState(0.8);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    if (d && !mount) {
      const saveData = (navigator as { connection?: { saveData?: boolean } }).connection?.saveData;
      const mounts = d.streams.mounts;
      setMount(
        (saveData ? mounts.find((m) => m.mount.includes("mobile")) : undefined)?.mount ??
          mounts.find((m) => m.primary)?.mount ??
          mounts[0]?.mount ??
          "",
      );
    }
  }, [d, mount]);
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume;
      audioRef.current.muted = muted;
    }
  }, [volume, muted]);
  useEffect(() => {
    if (d?.station.name)
      document.title = d.nowPlaying
        ? `${d.nowPlaying.artist ? `${d.nowPlaying.artist} – ` : ""}${d.nowPlaying.title} · ${d.station.name}`
        : d.station.name;
  }, [d]);

  const stop = useCallback(() => {
    hlsRef.current?.destroy();
    hlsRef.current = null;
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.removeAttribute("src");
      a.load();
    }
    setPlayer("idle");
  }, []);

  const playHls = async () => {
    const a = audioRef.current;
    if (!a || !d?.streams.hls) return false;
    if (a.canPlayType("application/vnd.apple.mpegurl")) {
      a.src = d.streams.hls;
      await a.play();
      return true;
    }
    const { default: Hls } = await import("hls.js");
    if (!Hls.isSupported()) return false;
    const hls = new Hls({ liveSyncDurationCount: 2 });
    hls.loadSource(d.streams.hls);
    hls.attachMedia(a);
    hlsRef.current = hls;
    await a.play();
    return true;
  };

  const play = async () => {
    const a = audioRef.current;
    const m = d?.streams.mounts.find((x) => x.mount === mount);
    if (!a || !m) return;
    setPlayer("connecting");
    try {
      // Cache-bust so a reconnect never replays a stale buffer.
      a.src = `${m.url}?t=${Date.now()}`;
      await a.play();
    } catch {
      try {
        if (!(await playHls())) throw new Error("no fallback");
      } catch {
        setPlayer("error");
      }
    }
  };

  const brand = brandStyle(d?.station.colors);
  const np0 = d?.nowPlaying;
  const playing = player === "playing" || player === "buffering";

  return (
    <div style={brand} className="min-h-screen bg-[var(--brand-bg)] text-legend">
      <div className="mx-auto max-w-5xl px-5 pb-16 pt-6">
        <header className="mb-10 flex items-center gap-3">
          {d?.station.logoUrl ? (
            <img src={d.station.logoUrl} alt="" className="h-9 w-auto" />
          ) : (
            <span className="size-3 rounded-full bg-[var(--brand)]" aria-hidden />
          )}
          <span className="font-display text-2xl font-semibold tracking-wide">
            {d?.station.name ?? " "}
          </span>
          <nav className="ml-auto flex gap-5 text-sm text-muted">
            <Link to="/listen/schedule" className="hover:text-legend">
              Schedule
            </Link>
            <a href="#request" className="hover:text-legend">
              Request a song
            </a>
          </nav>
        </header>

        <main>
          <section
            className="grid items-center gap-8 md:grid-cols-[minmax(0,320px)_1fr]"
            aria-label="Now playing"
          >
            <img
              src={np0?.artworkUrl ?? "/api/media/0/artwork"}
              alt=""
              className="aspect-square w-full max-w-80 rounded-xl object-cover shadow-[0_20px_60px_-20px_rgba(0,0,0,0.7)]"
            />
            <div>
              <p className="mb-2 flex items-center gap-2 text-sm text-muted">
                {d?.live.active ? (
                  <span className="rounded bg-[var(--brand)] px-2 py-0.5 font-display font-semibold text-black">
                    Live{d.live.dj ? ` with ${d.live.dj}` : ""}
                  </span>
                ) : d?.onAir ? (
                  "Now playing"
                ) : (
                  "Off air"
                )}
                {np0?.isRequest ? (
                  <span className="rounded border border-[var(--brand)] px-1.5 text-xs text-[var(--brand)]">
                    listener request
                  </span>
                ) : null}
              </p>
              <h1
                className="font-display text-5xl font-semibold leading-[1.02] md:text-6xl"
                aria-live="polite"
              >
                {np0?.title ?? (np.isLoading ? " " : "Music")}
              </h1>
              <p className="mt-2 text-xl text-muted">{np0?.artist}</p>

              <div className="mt-8 flex flex-wrap items-center gap-4">
                <button
                  type="button"
                  onClick={() => (playing || player === "connecting" ? stop() : void play())}
                  aria-label={playing ? "Stop" : "Play live"}
                  className="flex size-20 items-center justify-center rounded-full bg-[var(--brand)] text-black transition hover:brightness-110 focus-visible:outline-offset-4"
                >
                  {player === "connecting" ? (
                    <Loader2 className="size-8 animate-spin" />
                  ) : playing ? (
                    <Pause className="size-9" fill="currentColor" />
                  ) : (
                    <Play className="ml-1 size-9" fill="currentColor" />
                  )}
                </button>
                <div className="flex flex-col gap-2">
                  <span className="text-sm text-muted">
                    {player === "error"
                      ? "The stream can't be reached right now. Try another quality or come back in a minute."
                      : player === "buffering"
                        ? "Buffering…"
                        : playing
                          ? "Playing live"
                          : `${d?.listeners ?? 0} listening`}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setMuted((m) => !m)}
                      aria-label={muted ? "Unmute" : "Mute"}
                      className="text-muted hover:text-legend"
                    >
                      {muted ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
                    </button>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={volume}
                      onChange={(e) => setVolume(Number(e.target.value))}
                      aria-label="Volume"
                      className="w-32 accent-[var(--brand)]"
                    />
                    <select
                      value={mount}
                      onChange={(e) => {
                        setMount(e.target.value);
                        if (playing) setTimeout(() => void play(), 0);
                      }}
                      aria-label="Stream quality"
                      className="h-8 rounded border border-line-strong bg-transparent px-2 text-sm text-muted"
                    >
                      {d?.streams.mounts.map((m) => (
                        <option key={m.mount} value={m.mount} className="bg-desk">
                          {m.codec.toUpperCase()} {m.bitrate}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
              <audio
                ref={audioRef}
                preload="none"
                onPlaying={() => setPlayer("playing")}
                onWaiting={() => setPlayer((p) => (p === "playing" ? "buffering" : p))}
                onError={() => setPlayer((p) => (p === "idle" ? p : "error"))}
              />
            </div>
          </section>

          <div className="mt-14 grid gap-10 md:grid-cols-2">
            <section aria-labelledby="up-next">
              <h2 id="up-next" className="mb-3 font-display text-2xl font-semibold">
                Coming up
              </h2>
              <ol className="flex flex-col gap-2">
                {d?.next.map((n, i) => (
                  <li key={i} className="text-lg">
                    {n.kind === "news" ? (
                      <span className="text-muted">News</span>
                    ) : (
                      <>
                        <span>{n.title}</span> <span className="text-muted">{n.artist}</span>
                      </>
                    )}
                  </li>
                ))}
              </ol>
              <h2 className="mb-3 mt-10 font-display text-2xl font-semibold">Recently played</h2>
              <ul className="flex flex-col gap-3">
                {history.data?.items.map((h, i) => (
                  <li key={i} className="flex items-center gap-3">
                    <img
                      src={h.artworkUrl ?? "/api/media/0/artwork"}
                      alt=""
                      className="size-11 rounded object-cover"
                      loading="lazy"
                    />
                    <div className="min-w-0">
                      <p className="truncate">{h.title}</p>
                      <p className="truncate text-sm text-muted">{h.artist}</p>
                    </div>
                    <span className="ml-auto font-display text-sm tnum text-faint">
                      {clock(Date.parse(h.startedAt), d?.station.timezone, false)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
            <RequestForm />
          </div>
        </main>
        <footer className="mt-16 text-sm text-faint">
          <a href="/admin" className="hover:text-muted">
            Studio sign-in
          </a>
        </footer>
      </div>
    </div>
  );
}

function RequestForm() {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<{ id: number; artist: string; title: string } | null>(null);
  const [free, setFree] = useState({ artist: "", title: "" });
  const [dedication, setDedication] = useState("");
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mine, setMine] = useState<number[]>(readRequests());
  const results = useQuery({
    queryKey: ["req-search", q],
    queryFn: () =>
      get<{ items: { id: number; artist: string; title: string }[] }>(
        `/api/public/search?q=${encodeURIComponent(q)}`,
      ),
    enabled: q.length >= 2 && !picked,
  });
  const statuses = useQuery({
    queryKey: ["req-status", mine],
    queryFn: () =>
      Promise.all(
        mine.map((id) =>
          get<{ request: { id: number; status: string; artist: string; title: string } }>(
            `/api/public/requests/${id}`,
          )
            .then((r) => r.request)
            .catch(() => null),
        ),
      ),
    enabled: mine.length > 0,
    refetchInterval: 30_000,
  });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = picked
        ? { mediaId: picked.id }
        : { artist: free.artist || q, title: free.title };
      const r = await api<{ request: { id: number } }>("/api/public/requests", {
        method: "POST",
        body: {
          ...body,
          dedication: dedication || undefined,
          message: message || undefined,
          displayName: name || undefined,
          website: website || undefined,
        },
      });
      const ids = [...mine, r.request.id];
      setMine(ids);
      writeRequests(ids);
      setPicked(null);
      setQ("");
      setFree({ artist: "", title: "" });
      setDedication("");
      setMessage("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const STATUS: Record<string, string> = {
    pending: "Waiting for the studio",
    approved: "Approved, coming up",
    played: "Played",
    rejected: "Not this time",
    expired: "Expired",
  };
  const field =
    "h-10 w-full rounded-md border border-line-strong bg-black/20 px-3 text-legend placeholder:text-faint focus:border-[var(--brand)] focus:outline-none";
  return (
    <section id="request" aria-labelledby="req-title">
      <h2 id="req-title" className="mb-1 font-display text-2xl font-semibold">
        Request a song
      </h2>
      <p className="mb-4 text-sm text-muted">
        Search our library, add a dedication if you like. The studio reviews every request.
      </p>
      <form onSubmit={submit} className="flex flex-col gap-3">
        {picked ? (
          <div className="flex items-center justify-between rounded-md border border-[var(--brand)] px-3 py-2">
            <span>
              {picked.artist} – {picked.title}
            </span>
            <button
              type="button"
              className="text-sm text-muted hover:text-legend"
              onClick={() => setPicked(null)}
            >
              Change
            </button>
          </div>
        ) : (
          <div className="relative">
            <input
              className={field}
              placeholder="Search artist or title"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search the library"
            />
            {results.data?.items.length ? (
              <ul className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-line-strong bg-panel">
                {results.data.items.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className="w-full px-3 py-2 text-left text-sm hover:bg-panel-2"
                      onClick={() => setPicked(r)}
                    >
                      {r.artist} – {r.title}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {q.length >= 2 && results.data?.items.length === 0 ? (
              <div className="mt-2 grid grid-cols-2 gap-2">
                <p className="col-span-2 text-sm text-muted">
                  Not in the library? Send it anyway and the studio will look for it.
                </p>
                <input
                  className={field}
                  placeholder="Artist"
                  value={free.artist || q}
                  onChange={(e) => setFree({ ...free, artist: e.target.value })}
                  aria-label="Artist"
                />
                <input
                  className={field}
                  placeholder="Title"
                  value={free.title}
                  onChange={(e) => setFree({ ...free, title: e.target.value })}
                  aria-label="Title"
                  required
                />
              </div>
            ) : null}
          </div>
        )}
        <input
          className={field}
          placeholder="Dedication (optional)"
          value={dedication}
          onChange={(e) => setDedication(e.target.value)}
          maxLength={300}
          aria-label="Dedication"
        />
        <textarea
          className={`${field} h-20 py-2`}
          placeholder="Message to the studio (optional)"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={500}
          aria-label="Message"
        />
        <input
          className={field}
          placeholder="Your name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          aria-label="Your name"
        />
        <input
          tabIndex={-1}
          autoComplete="off"
          className="hidden"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          aria-hidden
        />
        {error ? (
          <p role="alert" className="text-sm text-clip">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={busy || (!picked && q.length < 2)}
          className="h-11 rounded-md bg-[var(--brand)] font-semibold text-black hover:brightness-110 disabled:opacity-50"
        >
          {busy ? "Sending…" : "Send request"}
        </button>
      </form>
      {statuses.data?.some(Boolean) ? (
        <div className="mt-6">
          <h3 className="mb-2 text-sm text-muted">Your requests</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {statuses.data
              .filter(Boolean)
              .reverse()
              .map((r) => (
                <li key={r!.id} className="flex justify-between gap-3">
                  <span className="truncate">
                    {r!.artist} – {r!.title}
                  </span>
                  <span
                    className={
                      r!.status === "played" || r!.status === "approved"
                        ? "text-[var(--brand)]"
                        : "text-muted"
                    }
                  >
                    {STATUS[r!.status] ?? r!.status}
                  </span>
                </li>
              ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
