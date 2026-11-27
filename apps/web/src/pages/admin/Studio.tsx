/**
 * Studio: one console for automated and manual operation. Two on-air players
 * (A/B), cart pads, a headphone pre-listen player, the automation queue and
 * transport, the microphone, and the mixer. Starting a player takes over from
 * automation (manual mode); "Hand back" fades the players and resumes automation.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Hand, RotateCcw, Zap } from "lucide-react";
import { useAuth } from "../../hooks/auth";
import { useLive } from "../../hooks/live";
import { toast } from "sonner";
import { errorMessage, get } from "../../lib/api";
import { clock } from "../../lib/format";
import type { Media, Playlist, PlayoutState, StudioPlayer, StudioPlayerId } from "../../lib/types";
import { MediaPicker, command } from "../../components/console";
import { VuBar } from "../../components/meters";
import { AutomationPanel, QueuePanel } from "../../components/studio/AutomationPanel";
import { CartWall } from "../../components/studio/CartWall";
import {
  CuePlayer,
  cueFromItem,
  cueFromMedia,
  type CueTrack,
} from "../../components/studio/CuePlayer";
import { MicPanel } from "../../components/studio/MicPanel";
import { LibraryDrawer } from "../../components/studio/LibraryDrawer";
import { MonitorPanel } from "../../components/studio/MonitorPanel";
import { PlayerDeck } from "../../components/studio/PlayerDeck";
import { Badge, Button, ConfirmButton, Panel, PageHeader, cx } from "../../components/ui";

const LIBRARY_KEY = "studio-library-open";

const BOUNDARY_LABEL: Record<string, string> = {
  cut: "Cut at boundary",
  let_finish: "Let finish",
  early_news: "News early",
  late_news: "News late",
  none: "On time",
};

const BUS_LABEL: Record<string, string> = {
  automation: "Automation",
  voiceover: "Voice-over",
  studio: "Studio",
  live: "Live mic",
  event: "Event",
  emergency: "Emergency",
};

const emptyPlayer = (id: StudioPlayerId): StudioPlayer => ({
  id,
  item: null,
  status: "empty",
  position: 0,
  gainDb: 0,
  cuePoint: 0,
  loop: false,
  autoNext: false,
  fading: false,
});

export default function Studio() {
  const { can } = useAuth();
  const controls = can("playout:control");
  const canMic = can("live:broadcast");
  const state = useLive((s) => s.state) as PlayoutState | null;
  const studio = state?.studio;
  const manual = Boolean(studio?.manual);
  // The voice-over picker is a dialog; everything else comes from the library drawer.
  const [voicePicker, setVoicePicker] = useState(false);
  const [cue, setCue] = useState<CueTrack | null>(null);
  // Closed on the first visit (only its tab shows); after that, as you left it.
  const [libraryOpen, setLibraryOpen] = useState(() => localStorage.getItem(LIBRARY_KEY) === "1");
  const [libraryFocus, setLibraryFocus] = useState(0);
  const showLibrary = (open: boolean) => {
    setLibraryOpen(open);
    localStorage.setItem(LIBRARY_KEY, open ? "1" : "0");
  };
  /** Load / Queue a track / Find: open the drawer with the search box focused. */
  const openLibrary = () => {
    showLibrary(true);
    setLibraryFocus((n) => n + 1);
  };
  const playlists = useQuery({
    queryKey: ["playlists"],
    queryFn: () => get<{ items: Playlist[] }>("/api/playlists"),
  });
  const playlistOfRole = (role: Playlist["role"]) =>
    playlists.data?.items.find((p) => p.role === role);
  const news = playlistOfRole("news");
  const jingles = playlistOfRole("jingle");
  // Quick sources in the voice-over dialog.
  const pickerSources = [
    { label: "All" },
    ...(news ? [{ label: "News", playlistId: news.id }] : []),
    ...(jingles ? [{ label: "Jingles", playlistId: jingles.id }] : []),
  ];
  const players: StudioPlayer[] = studio?.players.length
    ? studio.players
    : [emptyPlayer("A"), emptyPlayer("B")];
  const byId = (id: StudioPlayerId) => players.find((p) => p.id === id) ?? emptyPlayer(id);
  const loadable = {
    A: byId("A").status !== "playing",
    B: byId("B").status !== "playing",
  };

  // Keyboard: 1/2 play-pause the players; Space/→/R drive automation when it is on air.
  useEffect(() => {
    if (!controls) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (
        ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(t.tagName) ||
        t.isContentEditable ||
        t.getAttribute("role") === "slider" ||
        document.querySelector("dialog[open]") ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey
      )
        return;
      if (e.key === "1" || e.key === "2") {
        const p = byId(e.key === "1" ? "A" : "B");
        if (!p.item) return;
        e.preventDefault();
        void command(
          `/api/studio/players/${p.id}/${p.status === "playing" && !p.fading ? "pause" : "play"}`,
        );
        return;
      }
      if (manual) return;
      if (e.code === "Space") {
        e.preventDefault();
        void command(state?.paused ? "/api/playout/resume" : "/api/playout/pause");
      } else if (e.key === "ArrowRight") void command("/api/playout/skip");
      else if (e.key.toLowerCase() === "r") void command("/api/playout/replay-last");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const pickVoiceOver = async (m: Media) => {
    setVoicePicker(false);
    await command("/api/playout/voice-over", { mediaId: m.id });
  };

  return (
    <>
      <PageHeader
        title="Studio"
        description={
          controls
            ? "1 / 2 play or pause the players. While automation is on air: Space pauses, → skips, R replays."
            : "Read-only view of the studio."
        }
        actions={
          controls ? (
            <>
              {manual ? (
                <Button
                  tone="primary"
                  onClick={() => command("/api/studio/manual", { enabled: false })}
                >
                  <RotateCcw className="size-4" /> Hand back to automation
                </Button>
              ) : (
                <ConfirmButton
                  tone="default"
                  onConfirm={() => command("/api/studio/manual", { enabled: true })}
                  confirmLabel="Confirm: fade out automation"
                >
                  <Hand className="size-4" /> Take manual control
                </ConfirmButton>
              )}
              <ConfirmButton
                onConfirm={() =>
                  command("/api/playout/emergency", { action: "trigger", reason: "manual" })
                }
                confirmLabel="Confirm: play emergency loop"
              >
                <Zap className="size-4" /> Emergency
              </ConfirmButton>
            </>
          ) : null
        }
      />

      <div
        role="status"
        className={cx(
          "mb-4 flex flex-wrap items-center gap-3 rounded-lg border px-4 py-2.5 text-sm",
          manual ? "border-tally/60 bg-tally/10" : "border-line bg-panel",
        )}
      >
        <span
          className={cx(
            "rounded px-2 py-0.5 font-display text-sm font-semibold tracking-wider",
            manual ? "bg-tally text-desk" : "bg-signal/20 text-signal",
          )}
        >
          {manual ? "MANUAL" : "AUTOMATION"}
        </span>
        <span className="text-muted">
          {manual
            ? "You are driving the station with the players. Automation is on hold; 60 s of silence hands it back automatically."
            : "Automation runs the station. Press play on a player to take over; cart pads play on top without taking over."}
        </span>
        {state?.live.active ? <Badge tone="bad">live mic {state.live.mode}</Badge> : null}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="grid gap-4 lg:grid-cols-2">
            {(["A", "B"] as const).map((id) => (
              <PlayerDeck
                key={id}
                player={byId(id)}
                controls={controls && Boolean(studio)}
                onLoad={openLibrary}
                onPreview={() => {
                  const it = byId(id).item;
                  const c = it ? cueFromItem(it) : null;
                  if (c) setCue({ ...c });
                }}
              />
            ))}
          </div>
          <AutomationPanel
            state={state}
            controls={controls}
            onQueueTrack={openLibrary}
            onVoiceOver={() => setVoicePicker(true)}
          />
          <QueuePanel
            state={state}
            controls={controls}
            loadable={loadable}
            onPreview={(item) => {
              const c = cueFromItem(item);
              if (c) setCue(c);
            }}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <CartWall carts={studio?.carts ?? []} controls={controls && Boolean(studio)} />
          <CuePlayer
            track={cue}
            onFind={openLibrary}
            onDropMedia={(id) =>
              void get<{ media: Media }>(`/api/media/${id}`)
                .then((r) => setCue(cueFromMedia(r.media)))
                .catch((e: unknown) => toast.error(errorMessage(e)))
            }
            onDropQueueItem={(uid) => {
              const item = state?.queue.find((q) => q.uid === uid);
              const c = item ? cueFromItem(item) : null;
              if (c) setCue(c);
            }}
            controls={controls}
            loadable={loadable}
          />
          <MonitorPanel />
          {canMic ? <MicPanel /> : null}
          <MixerPanel state={state} controls={controls} />
          <StatusPanel state={state} />
        </div>
      </div>

      <LibraryDrawer
        open={libraryOpen}
        onOpenChange={showLibrary}
        focusSignal={libraryFocus}
        controls={controls && Boolean(studio)}
        loadable={loadable}
        onPreview={(m) => setCue(cueFromMedia(m))}
      />

      <MediaPicker
        open={voicePicker}
        onClose={() => setVoicePicker(false)}
        onPick={pickVoiceOver}
        sources={pickerSources}
        title="Voice-over: pick a voice track"
      />
    </>
  );
}

function MixerPanel({ state, controls }: { state: PlayoutState | null; controls: boolean }) {
  const meter = useLive((s) => s.meter);
  const [fader, setFader] = useState<number | null>(null);
  const send = () =>
    fader !== null &&
    command("/api/playout/fader", { value: fader }, "PATCH").then(() => setFader(null));
  return (
    <Panel title="Mixer">
      <div className="flex flex-col gap-2">
        <VuBar label="Master" peak={meter?.masterPeak ?? -120} rms={meter?.masterRms ?? -120} />
        {meter?.buses
          .filter(
            (b) =>
              (b.name !== "event" || state?.event.active) &&
              (b.name !== "emergency" || state?.emergency.active),
          )
          .map((b) => (
            <VuBar key={b.name} label={BUS_LABEL[b.name] ?? b.name} peak={b.peak} rms={b.rms} />
          ))}
      </div>
      <div className="mt-4 flex items-center gap-3 text-sm">
        <label htmlFor="fader" className="w-20 text-muted">
          Master fader
        </label>
        <input
          id="fader"
          type="range"
          min={0}
          max={1.5}
          step={0.01}
          disabled={!controls}
          value={fader ?? state?.fader ?? 1}
          onChange={(e) => setFader(Number(e.target.value))}
          onPointerUp={send}
          onKeyUp={send}
          className="flex-1 accent-tally"
        />
        <span className="w-12 text-right font-display tnum">
          {Math.round((fader ?? state?.fader ?? 1) * 100)}%
        </span>
      </div>
      {meter ? (
        <p className="mt-2 text-xs text-faint">Ducking {meter.duckGain.toFixed(1)} dB</p>
      ) : null}
    </Panel>
  );
}

function StatusPanel({ state }: { state: PlayoutState | null }) {
  return (
    <Panel title="Boundaries & outputs">
      {state?.boundaryLog.length ? (
        <ul className="mb-3 flex flex-col gap-2 text-sm">
          {state.boundaryLog.slice(0, 5).map((b, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="w-12 font-display tnum text-faint">
                {clock(b.boundaryAt, undefined, false)}
              </span>
              <Badge tone={b.action === "cut" ? "bad" : b.action === "none" ? "good" : "warn"}>
                {BOUNDARY_LABEL[b.action]}
              </Badge>
              <span className="ml-auto font-display tnum text-muted">
                {b.deviationMs > 0 ? "+" : ""}
                {(b.deviationMs / 1000).toFixed(1)} s
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-3 text-sm text-muted">News boundary decisions are listed here.</p>
      )}
      <ul className="flex flex-col gap-1.5 border-t border-line pt-3 text-sm">
        {state?.encoders.map((e) => (
          <li key={e.mount} className="flex items-center gap-2">
            <span className={cx("size-2 rounded-full", e.running ? "bg-signal" : "bg-clip")} />
            <span>{e.mount}</span>
            <span className="text-faint">{e.bitrate}</span>
            {e.restarts ? (
              <span className="ml-auto text-xs text-tally">{e.restarts} restarts</span>
            ) : null}
          </li>
        ))}
        {state ? (
          <li className="flex items-center gap-2">
            <span
              className={cx(
                "size-2 rounded-full",
                state.stereotool.running
                  ? "bg-signal"
                  : state.stereotool.enabled
                    ? "bg-clip"
                    : "bg-faint",
              )}
            />
            Stereo Tool{" "}
            <span className="text-faint">
              {state.stereotool.bypassed ? "bypassed" : state.stereotool.mode}
            </span>
          </li>
        ) : null}
      </ul>
    </Panel>
  );
}
