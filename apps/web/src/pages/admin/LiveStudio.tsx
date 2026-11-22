/**
 * Browser live studio (PLAN §5.3 / M8.2, M9.4): mic capture → AudioWorklet →
 * 48 kHz Int16 PCM over a WebSocket to the playout worker (ADR 0004).
 * The mic is never played back locally, so there is no feedback path.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Headphones, Mic, MicOff, Radio } from "lucide-react";
import { useAuth } from "../../hooks/auth";
import { useLive } from "../../hooks/live";
import { errorMessage, get, post } from "../../lib/api";
import { mmss, trackLine } from "../../lib/format";
import { command, NowPlayingCard, useTicker } from "../../components/console";
import { VuBar } from "../../components/meters";
import { Badge, Button, Field, Panel, PageHeader, Select, Tabs, Toggle } from "../../components/ui";

const WORKLET = `
class PcmSender extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(960); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const v = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n++] = v < 0 ? v * 32768 : v * 32767;
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.buffer.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("pcm-sender", PcmSender);
`;

type Phase = "idle" | "countdown" | "connecting" | "live" | "ending";

export default function LiveStudio() {
  const { user } = useAuth();
  const state = useLive((s) => s.state);
  const listeners = useLive((s) => s.listeners);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");
  const [processing, setProcessing] = useState(false);
  const [gain, setGain] = useState(1);
  const [muted, setMuted] = useState(false);
  const [level, setLevel] = useState({ peak: -120, rms: -120 });
  const [mode, setMode] = useState<"duck" | "takeover">("duck");
  const [record, setRecord] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [countdown, setCountdown] = useState(3);
  const [net, setNet] = useState({ sentKb: 0, underruns: 0, connected: false });
  const [micError, setMicError] = useState<string | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const previewRef = useRef<HTMLAudioElement | null>(null);
  const now = useTicker(1000);
  const recordings = useQuery({
    queryKey: ["my-sessions"],
    queryFn: () =>
      get<{
        sessions: {
          id: number;
          started_at: string;
          duration: number | null;
          mode: string;
          peak_listeners: number | null;
        }[];
      }>("/api/live/sessions"),
  });

  const next = state?.queue.find((q) => q.mediaId && q.kind !== "news");
  const othersLive = state?.live.active && state.live.userId !== user?.id;

  const openMic = async (id?: string) => {
    setMicError(null);
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: id ? { exact: id } : undefined,
          echoCancellation: processing,
          noiseSuppression: processing,
          autoGainControl: processing,
          channelCount: 1,
          sampleRate: 48000,
        },
      });
      streamRef.current = stream;
      setDevices(
        (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput"),
      );
      const ctx =
        ctxRef.current ?? new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
      ctxRef.current = ctx;
      if (!nodeRef.current) {
        await ctx.audioWorklet.addModule(
          URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" })),
        );
      }
      const src = ctx.createMediaStreamSource(stream);
      const g = ctx.createGain();
      g.gain.value = muted ? 0 : gain;
      gainRef.current = g;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      const node = nodeRef.current ?? new AudioWorkletNode(ctx, "pcm-sender");
      nodeRef.current = node;
      node.port.onmessage = (e) => {
        const ws = wsRef.current;
        if (ws?.readyState === 1) {
          ws.send(e.data as ArrayBuffer);
          setNet((n) => ({ ...n, sentKb: n.sentKb + (e.data as ArrayBuffer).byteLength / 1024 }));
        }
      };
      src.connect(g).connect(analyser);
      g.connect(node);
      // The worklet must be pulled by the graph; route it to a muted sink (never to the speakers).
      const sink = ctx.createGain();
      sink.gain.value = 0;
      node.connect(sink).connect(ctx.destination);
      const data = new Float32Array(analyser.fftSize);
      const tick = () => {
        if (!streamRef.current) return;
        analyser.getFloatTimeDomainData(data);
        let peak = 0;
        let sum = 0;
        for (const v of data) {
          peak = Math.max(peak, Math.abs(v));
          sum += v * v;
        }
        setLevel({
          peak: peak > 0 ? 20 * Math.log10(peak) : -120,
          rms: sum > 0 ? 10 * Math.log10(sum / data.length) : -120,
        });
        requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {
      setMicError(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Microphone access was blocked. Allow it in the browser's site settings and try again."
          : errorMessage(e),
      );
    }
  };

  useEffect(() => {
    if (gainRef.current) gainRef.current.gain.value = muted ? 0 : gain;
  }, [gain, muted]);

  useEffect(
    () => () => {
      wsRef.current?.close();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      void ctxRef.current?.close();
    },
    [],
  );

  const goLive = async () => {
    if (!streamRef.current) await openMic(deviceId || undefined);
    if (!streamRef.current) return;
    setPhase("countdown");
    for (let i = 3; i > 0; i -= 1) {
      setCountdown(i);
      await new Promise((r) => setTimeout(r, 1000));
    }
    setPhase("connecting");
    try {
      const res = await post<{ token: string; wsPath: string }>("/api/live/start", {
        mode,
        source: "studio",
        record,
      });
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}${res.wsPath}`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "hello", channels: 1, sampleRate: 48000 }));
        setNet({ sentKb: 0, underruns: 0, connected: true });
        setPhase("live");
        toast.success("You are live");
      };
      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(String(e.data)) as { type: string; underruns: number };
          if (m.type === "stats") setNet((n) => ({ ...n, underruns: m.underruns }));
        } catch {
          // ignore
        }
      };
      ws.onclose = () => setNet((n) => ({ ...n, connected: false }));
    } catch (e) {
      toast.error(errorMessage(e));
      setPhase("idle");
    }
  };

  const endLive = async () => {
    setPhase("ending");
    try {
      await post("/api/live/stop");
      toast.success("Live session ended, automation resumed");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      wsRef.current?.close();
      wsRef.current = null;
      setPhase("idle");
      void recordings.refetch();
    }
  };

  const playPreview = () => {
    const a = previewRef.current;
    if (!a || !next?.mediaId) return;
    a.src = `/api/media/${next.mediaId}/preview`;
    a.currentTime = 0;
    void a.play();
    setTimeout(() => a.pause(), 30_000);
  };

  const live = phase === "live" || (state?.live.active && state.live.userId === user?.id);
  const liveFor = state?.live.startedAt ? (now - state.live.startedAt) / 1000 : 0;

  return (
    <>
      <PageHeader
        title="Live studio"
        description="Pick your microphone, check the level, then go live. Music ducks under your voice in duck mode, or stops in takeover mode."
      />
      {othersLive ? (
        <p className="mb-4 rounded-md border border-tally/50 bg-tally/10 p-3 text-sm">
          Another DJ is on air. You can prepare, but only one live session runs at a time.
        </p>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-4">
          <Panel title="Microphone">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Input device">
                {(id) => (
                  <Select
                    id={id}
                    value={deviceId}
                    onChange={(e) => {
                      setDeviceId(e.target.value);
                      void openMic(e.target.value);
                    }}
                  >
                    <option value="">
                      {devices.length ? "Default microphone" : "Allow microphone access first"}
                    </option>
                    {devices.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Microphone ${d.deviceId.slice(0, 6)}`}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={`Input gain ${(20 * Math.log10(gain || 0.001)).toFixed(1)} dB`}>
                {(id) => (
                  <input
                    id={id}
                    type="range"
                    min={0}
                    max={4}
                    step={0.01}
                    value={gain}
                    onChange={(e) => setGain(Number(e.target.value))}
                    className="mt-2 accent-tally"
                  />
                )}
              </Field>
            </div>
            <div className="mt-4">
              <VuBar
                label={muted ? "Muted" : "Mic"}
                peak={muted ? -120 : level.peak}
                rms={muted ? -120 : level.rms}
              />
            </div>
            {micError ? (
              <p role="alert" className="mt-3 text-sm text-clip">
                {micError}
              </p>
            ) : null}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button onClick={() => openMic(deviceId || undefined)}>
                <Mic className="size-4" /> {streamRef.current ? "Restart mic" : "Enable microphone"}
              </Button>
              <Button
                tone={muted ? "live" : "default"}
                onClick={() => setMuted((m) => !m)}
                aria-pressed={muted}
              >
                <MicOff className="size-4" /> {muted ? "Unmute" : "Mute"}
              </Button>
              <Toggle
                checked={processing}
                onChange={setProcessing}
                label="Browser noise suppression"
              />
            </div>
            <p className="mt-3 flex items-center gap-2 text-xs text-faint">
              <Headphones className="size-4" /> Monitor the station on headphones from the listener
              page; the studio never plays your mic back.
            </p>
          </Panel>

          <Panel title="Go live">
            <div className="flex flex-wrap items-center gap-6">
              <div className="flex flex-col gap-1.5">
                <span className="text-sm text-muted">Mode</span>
                <Tabs
                  value={mode}
                  onChange={(m) => {
                    setMode(m);
                    if (live) void command("/api/live/mode", { mode: m });
                  }}
                  tabs={[
                    { value: "duck", label: "Duck music" },
                    { value: "takeover", label: "Take over" },
                  ]}
                />
              </div>
              <Toggle
                checked={record}
                onChange={setRecord}
                label="Record this session"
                disabled={Boolean(live)}
              />
            </div>
            <div className="mt-6 flex items-center gap-4">
              {live ? (
                <>
                  <Button tone="danger" size="lg" busy={phase === "ending"} onClick={endLive}>
                    End live
                  </Button>
                  <span className="inline-flex items-center gap-2 rounded bg-clip px-2.5 py-1 font-display font-semibold text-white tally-live">
                    <Radio className="size-4" /> On air {mmss(liveFor)}
                  </span>
                  <span className="text-sm text-muted">{listeners} listening</span>
                </>
              ) : phase === "countdown" ? (
                <span
                  className="font-display text-5xl font-bold text-tally tnum"
                  aria-live="assertive"
                >
                  {countdown}
                </span>
              ) : (
                <Button
                  tone="live"
                  size="lg"
                  busy={phase === "connecting"}
                  disabled={Boolean(othersLive)}
                  onClick={goLive}
                >
                  <Mic className="size-5" /> Go live
                </Button>
              )}
            </div>
            {live ? (
              <p className="mt-3 text-xs text-faint">
                Uplink {net.connected ? "connected" : "reconnecting"} · sent{" "}
                {(net.sentKb / 1024).toFixed(1)} MB · jitter underruns {net.underruns}
              </p>
            ) : null}
          </Panel>

          <Panel title="External encoder">
            <p className="text-sm text-muted">
              Prefer BUTT, Mixxx or RadioDJ? Point them at the Icecast{" "}
              <code className="text-legend">/live</code> mount on this server (source user{" "}
              <code className="text-legend">source</code>, password from your administrator), then
              ask an operator to start a live session with source “Icecast”. Expect 1–3 s of extra
              delay.
            </p>
          </Panel>
        </div>

        <div className="flex flex-col gap-4">
          <Panel title="On air now">
            <NowPlayingCard np={state?.nowPlaying ?? null} paused={state?.paused} compact />
          </Panel>
          <Panel title="Next track preview">
            {next ? (
              <>
                <p className="truncate">{trackLine(next)}</p>
                <p className="text-sm text-muted">{mmss(next.duration)}</p>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" onClick={playPreview}>
                    <Headphones className="size-4" /> Preview 30 s
                  </Button>
                  <Button size="sm" tone="ghost" onClick={() => previewRef.current?.pause()}>
                    Stop
                  </Button>
                </div>
                <audio ref={previewRef} preload="none" />
                <p className="mt-2 text-xs text-faint">
                  Plays only in your browser; the stream is not affected.
                </p>
              </>
            ) : (
              <p className="text-sm text-muted">No upcoming track in the queue.</p>
            )}
          </Panel>
          <Panel title="My recent shifts">
            <ul className="flex flex-col gap-1 text-sm">
              {recordings.data?.sessions.slice(0, 8).map((s) => (
                <li key={s.id} className="flex justify-between gap-2">
                  <span>{new Date(s.started_at).toLocaleString()}</span>
                  <span className="text-muted">
                    {mmss(s.duration)} <Badge>{s.mode}</Badge>
                  </span>
                </li>
              ))}
              {recordings.data?.sessions.length === 0 ? (
                <li className="text-muted">No sessions yet.</li>
              ) : null}
            </ul>
          </Panel>
        </div>
      </div>
    </>
  );
}
