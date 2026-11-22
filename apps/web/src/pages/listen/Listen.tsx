import { useCallback, useEffect, useRef, useState } from "react";

/**
 * M0.10 walking skeleton: plays the Icecast `/hq.mp3` mount that the playout
 * worker feeds (tone -> mock Stereo Tool -> MP3 320k). M9 replaces this with the
 * real public listen page (now-playing, history, requests).
 */
const STREAM_URL = import.meta.env.VITE_STREAM_URL ?? "/stream/hq.mp3";

type StreamState = "idle" | "connecting" | "live" | "buffering" | "paused" | "error";

const STATE_LABEL: Record<StreamState, string> = {
  idle: "Ready",
  connecting: "Connecting…",
  live: "Live",
  buffering: "Buffering…",
  paused: "Paused",
  error: "Stream unavailable",
};

export function Listen() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [state, setState] = useState<StreamState>("idle");

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onPlaying = () => setState("live");
    const onWaiting = () => setState("buffering");
    const onPause = () => setState("paused");
    const onError = () => setState("error");

    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("error", onError);
    return () => {
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("error", onError);
    };
  }, []);

  const toggle = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (!audio.paused) {
      audio.pause();
      return;
    }

    // A live stream keeps buffering while paused, so restart at the live edge.
    setState("connecting");
    audio.src = STREAM_URL;
    audio.load();
    try {
      await audio.play();
    } catch {
      setState("error");
    }
  }, []);

  const live = state === "live" || state === "buffering";

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Online Radio Player</p>
          <h1>Listen</h1>
        </div>
        <span className={live ? "badge badge-live" : "badge"}>
          <span className={live ? "signal" : "signal signal-idle"} />
          {STATE_LABEL[state]}
        </span>
      </header>

      <section className="player">
        <div className="player-art" aria-hidden="true">
          <span>ON AIR</span>
        </div>
        <div className="player-body">
          <p className="label">Now playing</p>
          <h2>M0 test tone</h2>
          <p className="player-note">
            Walking-skeleton stream: 1 kHz tone through the mock Stereo Tool into Icecast. Real
            scheduling and music arrive in M4/M5.
          </p>

          <audio ref={audioRef} preload="none" crossOrigin="anonymous" />

          <div className="actions">
            <button className="button primary" type="button" onClick={toggle}>
              {live ? "Stop" : "Play live"}
            </button>
            <a className="button" href="/">
              Control room
            </a>
          </div>

          <p className="stream-url">{STREAM_URL}</p>
        </div>
      </section>

      <footer>
        <span>MP3 320k · Icecast</span>
        <span>Thimeo Stereo Tool is commercial software; binaries are not included.</span>
      </footer>
    </main>
  );
}
