/**
 * Direct studio monitor controls: hear the mix before Stereo Tool with
 * ~150 ms delay. Playback lives in hooks/monitor.ts (keeps going across pages).
 */
import { useEffect, useState } from "react";
import { Ear, Square } from "lucide-react";
import {
  canPickOutput,
  monitorActive,
  setMonitorLatency,
  setMonitorMic,
  setMonitorRate,
  setMonitorSink,
  setMonitorVolume,
  toggleMonitor,
  useMonitor,
} from "../../hooks/monitor";
import { VuBar } from "../meters";
import { Badge, Button, Panel, Select, Tabs, Toggle } from "../ui";

const STATUS: Record<string, string> = {
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  playing: "Listening",
  idle: "Off",
  error: "Unavailable",
};

export function MonitorPanel() {
  const m = useMonitor((s) => s);
  const active = monitorActive(m.status);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    if (!canPickOutput) return;
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((d) => setOutputs(d.filter((x) => x.kind === "audiooutput")));
  }, [active]);

  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <Ear className="size-4 text-signal" /> Direct monitor
        </span>
      }
      actions={
        <Badge tone={m.status === "playing" ? "good" : active ? "warn" : "neutral"}>
          {STATUS[m.status]}
        </Badge>
      }
    >
      <p className="text-sm text-muted">
        Hear the studio mix <strong className="text-legend">before Stereo Tool</strong>, about{" "}
        {m.latencyMs} ms behind — no processing, no stream delay. Listeners still get the processed
        stream.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <Button tone={active ? "default" : "primary"} onClick={toggleMonitor}>
          {active ? (
            <>
              <Square className="size-3.5" fill="currentColor" /> Stop monitor
            </>
          ) : (
            <>
              <Ear className="size-4" /> Listen direct
            </>
          )}
        </Button>
        {active ? (
          <span className="font-display text-sm tnum text-faint">
            buffer {m.bufferedMs} ms · dropouts {m.underruns}
          </span>
        ) : null}
      </div>
      {active ? (
        <div className="mt-3">
          <VuBar label="Monitor" peak={m.peakDb} rms={m.peakDb - 6} />
        </div>
      ) : null}
      {m.error && m.status !== "playing" ? (
        <p role="alert" className="mt-2 text-xs text-clip">
          {m.error}
        </p>
      ) : null}

      <div className="mt-4 flex flex-col gap-3 border-t border-line pt-3 text-sm">
        <Toggle
          checked={m.mic}
          onChange={setMonitorMic}
          label="Include my microphone (you hear yourself delayed)"
        />
        <div className="flex flex-wrap items-center gap-3">
          <span className="w-20 text-xs text-muted">Quality</span>
          <Tabs
            value={String(m.rate) as "48000" | "24000"}
            onChange={(v) => setMonitorRate(v === "24000" ? 24000 : 48000)}
            tabs={[
              { value: "48000", label: "Full 48 kHz" },
              { value: "24000", label: "Light 24 kHz" },
            ]}
          />
        </div>
        <div className="flex items-center gap-3">
          <label htmlFor="monitor-latency" className="w-20 text-xs text-muted">
            Delay {m.latencyMs} ms
          </label>
          <input
            id="monitor-latency"
            type="range"
            min={60}
            max={600}
            step={10}
            value={m.latencyMs}
            onChange={(e) => setMonitorLatency(Number(e.target.value))}
            className="flex-1 accent-signal"
            title="Lower = closer to real time; raise it if you hear dropouts"
          />
        </div>
        <div className="flex items-center gap-3">
          <label htmlFor="monitor-volume" className="w-20 text-xs text-muted">
            Volume
          </label>
          <input
            id="monitor-volume"
            type="range"
            min={0}
            max={1.5}
            step={0.01}
            value={m.volume}
            onChange={(e) => setMonitorVolume(Number(e.target.value))}
            className="flex-1 accent-signal"
          />
        </div>
        {canPickOutput && outputs.length > 1 ? (
          <Select
            aria-label="Monitor output"
            className="h-8 text-xs"
            value={m.sinkId}
            onChange={(e) => setMonitorSink(e.target.value)}
          >
            {outputs.map((o) => (
              <option key={o.deviceId} value={o.deviceId === "default" ? "" : o.deviceId}>
                {o.label || "Output device"}
              </option>
            ))}
          </Select>
        ) : null}
        <p className="text-xs text-faint">
          Full quality uses about 1.5 Mbit/s (Light: 0.8 Mbit/s). Starting the monitor stops the
          stream player in the header, and the other way round.
        </p>
      </div>
    </Panel>
  );
}
