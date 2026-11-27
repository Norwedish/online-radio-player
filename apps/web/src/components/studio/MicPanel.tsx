/**
 * Browser microphone → air (PLAN §5.3 / M8.2, ADR 0004): mic capture →
 * AudioWorklet → 48 kHz Int16 PCM over a WebSocket to the playout worker.
 * The mic is never played back locally, so there is no feedback path.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Mic, MicOff, Radio } from "lucide-react";
import { useAuth } from "../../hooks/auth";
import { useLive } from "../../hooks/live";
import { errorMessage, get, post } from "../../lib/api";
import { mmss } from "../../lib/format";
import { command, useTicker } from "../console";
import { VuBar } from "../meters";
import { Badge, Button, Panel, Select, Tabs, Toggle } from "../ui";

type Phase = "idle" | "countdown" | "connecting" | "live" | "ending";

export function MicPanel() {
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
  const [micOpen, setMicOpen] = useState(false);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const now = useTicker(1000);
  const sessions = useQuery({
    queryKey: ["my-sessions"],
    queryFn: () =>
      get<{
        sessions: { id: number; started_at: string; duration: number | null; mode: string }[];
      }>("/api/live/sessions"),
  });

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
      setMicOpen(true);
      setDevices(
        (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput"),
      );
      const ctx =
        ctxRef.current ?? new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
      ctxRef.current = ctx;
      if (!nodeRef.current) {
        // Same-origin file: the CSP (script-src 'self') blocks blob: worklets.
        await ctx.audioWorklet.addModule("/worklets/pcm-sender.js");
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
      toast.success("Live session ended");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      wsRef.current?.close();
      wsRef.current = null;
      setPhase("idle");
      void sessions.refetch();
    }
  };

  const live = phase === "live" || (state?.live.active && state.live.userId === user?.id);
  const liveFor = state?.live.startedAt ? (now - state.live.startedAt) / 1000 : 0;

  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <Mic className="size-4" /> Microphone
        </span>
      }
      actions={
        live ? (
          <span className="inline-flex items-center gap-1.5 rounded bg-clip px-2 py-0.5 font-display text-sm font-semibold text-white tally-live">
            <Radio className="size-3.5" /> On air {mmss(liveFor)}
          </span>
        ) : null
      }
    >
      {othersLive ? (
        <p className="mb-3 rounded-md border border-tally/50 bg-tally/10 p-2 text-sm">
          Another DJ is on air. You can prepare, but only one live session runs at a time.
        </p>
      ) : null}
      <div className="flex flex-col gap-3">
        <Select
          aria-label="Input device"
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
        <VuBar
          label={muted ? "Muted" : "Mic"}
          peak={muted ? -120 : level.peak}
          rms={muted ? -120 : level.rms}
        />
        <div className="flex items-center gap-3 text-sm">
          <label htmlFor="mic-gain" className="w-20 text-xs text-muted">
            Gain {(20 * Math.log10(gain || 0.001)).toFixed(0)} dB
          </label>
          <input
            id="mic-gain"
            type="range"
            min={0}
            max={4}
            step={0.01}
            value={gain}
            onChange={(e) => setGain(Number(e.target.value))}
            className="flex-1 accent-tally"
          />
        </div>
        {micError ? (
          <p role="alert" className="text-sm text-clip">
            {micError}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => openMic(deviceId || undefined)}>
            <Mic className="size-4" /> {micOpen ? "Restart mic" : "Enable microphone"}
          </Button>
          <Button
            size="sm"
            tone={muted ? "live" : "default"}
            onClick={() => setMuted((m) => !m)}
            aria-pressed={muted}
          >
            <MicOff className="size-4" /> {muted ? "Unmute" : "Mute"}
          </Button>
          <Toggle checked={processing} onChange={setProcessing} label="Noise suppression" />
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
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
          <Toggle checked={record} onChange={setRecord} label="Record" disabled={Boolean(live)} />
        </div>
        <div className="flex items-center gap-3">
          {live ? (
            <>
              <Button tone="danger" size="lg" busy={phase === "ending"} onClick={endLive}>
                End live
              </Button>
              <span className="text-sm text-muted">{listeners} listening</span>
            </>
          ) : phase === "countdown" ? (
            <span className="font-display text-5xl font-bold text-tally tnum" aria-live="assertive">
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
          <p className="text-xs text-faint">
            Uplink {net.connected ? "connected" : "reconnecting"} · sent{" "}
            {(net.sentKb / 1024).toFixed(1)} MB · jitter underruns {net.underruns}
          </p>
        ) : (
          <p className="text-xs text-faint">
            Duck lowers the music under your voice (players included); take over pauses automation.
            Prefer BUTT or Mixxx? Send to the Icecast <code>/live</code> mount and ask an operator
            to start an Icecast live session.
          </p>
        )}
        {sessions.data?.sessions.length ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-xs text-muted">My recent shifts</summary>
            <ul className="mt-2 flex flex-col gap-1">
              {sessions.data.sessions.slice(0, 6).map((s) => (
                <li key={s.id} className="flex justify-between gap-2">
                  <span>{new Date(s.started_at).toLocaleString()}</span>
                  <span className="text-muted">
                    {mmss(s.duration)} <Badge>{s.mode}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </Panel>
  );
}
