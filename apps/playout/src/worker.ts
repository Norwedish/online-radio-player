/**
 * radio-playout wiring: plan source → engine/mixer → audio clock → Stereo Tool
 * adapter → encoder hub (+ HLS, recordings), plus the protocol server for
 * radio-api and the browser-studio live uplink.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  secret,
  stereotoolKeyFile,
  type CommandType,
  type CommandPayload,
  type QueueItem,
  type RuntimeConfig,
  type WorkerAlert,
} from "@radio/shared";
import { AudioClock } from "./audio/clock.js";
import { LiveBus } from "./audio/live-bus.js";
import { Mixer } from "./audio/mixer.js";
import { PlayoutEngine } from "./engine.js";
import { EncoderHub, type EncoderTarget } from "./encoders/hub.js";
import { LiveServer } from "./live/live-server.js";
import { ProtocolServer } from "./protocol/server.js";
import { SqlitePlanSource, type PlanSource } from "./scheduler/plan-source.js";
import { createStereoTool, type StereoToolAdapter } from "./stereotool/adapter.js";

export interface WorkerOptions {
  source?: PlanSource;
  log?: (m: string) => void;
  /** Override the protocol endpoint (tests). */
  endpoint?: { socket: string } | { port: number; host?: string };
  livePort?: number;
  /** Disable outputs (unit tests). */
  outputs?: boolean;
  token?: string;
}

export class PlayoutWorker {
  readonly log: (m: string) => void;
  readonly source: PlanSource;
  readonly live: LiveBus;
  readonly mixer: Mixer;
  readonly engine: PlayoutEngine;
  readonly hub: EncoderHub;
  readonly clock: AudioClock;
  readonly protocol: ProtocolServer;
  readonly liveServer: LiveServer;
  stereotool!: StereoToolAdapter;
  private timers: NodeJS.Timeout[] = [];
  private recording: { id: string; path: string } | null = null;
  private alertDedupe = new Map<string, number>();
  private icecastAlerted = false;

  constructor(
    readonly config: RuntimeConfig,
    private readonly opts: WorkerOptions = {},
  ) {
    this.log = opts.log ?? ((m) => console.log(`[playout] ${m}`));
    this.source = opts.source ?? new SqlitePlanSource(config.db.file, config.station.timezone);
    const s = <T>(key: string, fallback: T) => this.source.setting<T>(key, fallback);
    this.live = new LiveBus(config.scheduler.live.studio.jitterBufferMs);
    this.mixer = new Mixer(this.live, {
      duckDb: s("live.duckDb", config.scheduler.live.duckDb),
      duckAttackMs: s("live.duckAttackMs", config.scheduler.live.duckAttackMs),
      duckReleaseMs: s("live.duckReleaseMs", config.scheduler.live.duckReleaseMs),
      masterGain: s("audio.masterGain", config.audio.masterGain),
    });
    this.hub = new EncoderHub({
      maxQueueSeconds: 10,
      log: this.log,
      alert: (a) => this.alert(a),
      redact: (t) => this.redact(t),
    });
    this.engine = new PlayoutEngine({
      source: this.source,
      mixer: this.mixer,
      toleranceSeconds: s("audio.boundaryToleranceSeconds", config.audio.boundaryToleranceSeconds),
      silenceThresholdDb: s("audio.silenceThresholdDb", config.audio.silenceThresholdDb),
      silenceSeconds: s("audio.silenceSeconds", config.audio.silenceSeconds),
      emergencyFile: config.audio.emergencyFile,
      maxCrossfadeSeconds: s("audio.autocue.maxOverlap", 6),
      log: this.log,
      alert: (a) => this.alert(a),
      status: () => ({
        encoders: this.hub.statuses(),
        stereotool: this.stereotool?.status() ?? {
          enabled: false,
          running: false,
          bypassed: true,
          mode: "none",
          edition: null,
          restarts: 0,
          error: null,
        },
      }),
    });
    this.engine.on("worker-event", (type, payload) => this.protocol.broadcast(type, payload));
    this.clock = new AudioClock((frames) => {
      const monitor = this.liveServer.monitor;
      this.mixer.wantDry = monitor.wantsDry;
      const pcm = this.mixer.render(frames);
      this.engine.onRendered(this.mixer.lastRmsDb, frames);
      // Studio monitor taps the program *before* Stereo Tool (no processing, no encoder delay).
      monitor.feed(pcm, this.mixer.lastDry);
      this.stereotool.writePcm(pcm);
    });
    this.protocol = new ProtocolServer((type, payload) => this.handle(type, payload), {
      token: opts.token ?? process.env.PLAYOUT_TOKEN,
      log: this.log,
      hello: () => ({ version: "1.0.0", state: this.engine.getState() }),
    });
    this.liveServer = new LiveServer(this.live, this.log);
  }

  private redact(text: string): string {
    const pw = secret(this.config.icecast.sourcePasswordEnv);
    return pw ? text.split(pw).join("***") : text;
  }

  alert(a: WorkerAlert): void {
    const now = Date.now();
    const last = this.alertDedupe.get(a.type) ?? 0;
    if (now - last < 30_000 && a.severity !== "critical") return;
    this.alertDedupe.set(a.type, now);
    this.log(`alert ${a.severity} ${a.type}: ${a.message}`);
    this.protocol?.broadcast("alert", a);
  }

  icecastUrl(mount: string): string {
    const pw = encodeURIComponent(secret(this.config.icecast.sourcePasswordEnv) ?? "hackme");
    return `icecast://source:${pw}@${this.config.icecast.host}:${this.config.icecast.port}/${mount.replace(/^\//, "")}`;
  }

  outputTargets(): EncoderTarget[] {
    const targets: EncoderTarget[] = this.config.icecast.mounts.map((m) => ({
      kind: "icecast" as const,
      mount: m.name,
      codec: m.codec,
      bitrate: m.bitrate,
      contentType: m.contentType,
      url: this.icecastUrl(m.name),
      name: `${this.config.station.name}${m.primary ? "" : ` (${m.bitrate})`}`,
      description: this.config.station.name,
      public: m.public,
    }));
    const hls = this.config.icecast.hls;
    if (hls.enabled)
      targets.push({
        kind: "hls",
        dir: this.config.hlsDir,
        segmentSeconds: hls.segmentSeconds,
        listSize: hls.listSize,
        bitrate: hls.bitrate,
      });
    return targets;
  }

  private async startStereoTool(): Promise<StereoToolAdapter> {
    const st = createStereoTool(this.config.stereotool, {
      mock: this.config.stereotoolMock,
      mockScript: join(this.config.rootDir, "scripts/mock-stereotool.mjs"),
      hostScript: join(this.config.rootDir, "apps/playout/bin/stereotool-host.mjs"),
      homeDir: join(this.config.dataDir, "var/stereotool"),
      keyFile: stereotoolKeyFile(this.config.dataDir),
      log: this.log,
      alert: (a) => this.alert(a),
    });
    st.onOutput((chunk) => this.hub.write(chunk));
    await st.start();
    return st;
  }

  /** New licence key: restart Stereo Tool with it (a short audio hiccup, no service restart). */
  async reloadStereoTool(): Promise<void> {
    const old = this.stereotool;
    this.stereotool = await this.startStereoTool();
    await old?.stop();
    this.log("stereotool: reloaded with the current licence key");
  }

  async start(): Promise<void> {
    this.stereotool = await this.startStereoTool();
    if (this.opts.outputs !== false) for (const t of this.outputTargets()) this.hub.add(t);
    const endpoint =
      this.opts.endpoint ??
      (this.config.workerSocket
        ? { socket: this.config.workerSocket }
        : { port: this.config.worker.protocolPort });
    await this.protocol.listen(endpoint);
    await this.liveServer.listen(this.opts.livePort ?? this.config.worker.protocolPort + 1);
    this.log(
      `protocol on ${this.protocol.address()}, live uplink on :${this.opts.livePort ?? this.config.worker.protocolPort + 1}`,
    );
    this.clock.start();
    this.engine.start();
    // 10 Hz meters, 2 s status, encoder watchdog.
    this.timers.push(
      setInterval(() => this.protocol.broadcast("meter", this.mixer.readMeters()), 100),
    );
    this.timers.push(
      setInterval(() => {
        this.protocol.broadcast("encoder:status", { mounts: this.hub.statuses() });
        this.protocol.broadcast("stereotool:status", this.stereotool.status());
        const down = this.hub.icecastDownSeconds();
        if (down >= 15 && !this.icecastAlerted) {
          this.icecastAlerted = true;
          this.alert({
            type: "icecast_source_loss",
            severity: "critical",
            message: `All Icecast mounts have been down for ${Math.round(down)} s`,
          });
          this.protocol.broadcast("icecast:status", { up: false, downSeconds: down });
        } else if (down === 0 && this.icecastAlerted) {
          this.icecastAlerted = false;
          this.protocol.broadcast("icecast:status", { up: true, downSeconds: 0 });
          this.alert({
            type: "icecast_source_restored",
            severity: "info",
            message: "Icecast mounts are back",
          });
        }
      }, 2000),
    );
    this.timers.push(
      setInterval(() => this.protocol.broadcast("state", this.engine.getState()), 5000),
    );
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.clock.stop();
    this.engine.shutdown();
    await this.stereotool?.stop();
    await this.hub.stopAll();
    await this.protocol.close();
    await this.liveServer.close();
    this.source.close();
  }

  private reloadSettings(): void {
    const s = <T>(key: string, fallback: T) => this.source.setting<T>(key, fallback);
    this.engine.toleranceSeconds = s(
      "audio.boundaryToleranceSeconds",
      this.config.audio.boundaryToleranceSeconds,
    );
    this.engine.silenceThresholdDb = s(
      "audio.silenceThresholdDb",
      this.config.audio.silenceThresholdDb,
    );
    this.engine.silenceSeconds = s("audio.silenceSeconds", this.config.audio.silenceSeconds);
    this.engine.maxCrossfadeSeconds = s("audio.autocue.maxOverlap", 6);
    this.mixer.duckDb = s("live.duckDb", this.config.scheduler.live.duckDb);
    this.mixer.setDuckTiming(
      s("live.duckAttackMs", this.config.scheduler.live.duckAttackMs),
      s("live.duckReleaseMs", this.config.scheduler.live.duckReleaseMs),
    );
    this.mixer.fader = s("audio.masterGain", this.mixer.fader);
  }

  /** Dispatches validated protocol commands (M4.7/M6.1). */
  async handle(type: CommandType, payload: unknown): Promise<unknown> {
    const e = this.engine;
    switch (type) {
      case "ping":
        return { pong: Date.now() };
      case "state:get":
      case "queue:list":
        return e.getState();
      case "play":
        e.play();
        break;
      case "pause":
        e.pause();
        break;
      case "resume":
        e.resume();
        break;
      case "stop":
        e.stop();
        break;
      case "skip":
        e.skip();
        break;
      case "seek":
        e.seek((payload as CommandPayload<"seek">).position);
        break;
      case "queue:remove":
        e.queueRemove((payload as CommandPayload<"queue:remove">).uid);
        break;
      case "queue:move": {
        const p = payload as CommandPayload<"queue:move">;
        e.queueMove(p.uid, p.toIndex);
        break;
      }
      case "queue:insert": {
        const p = payload as CommandPayload<"queue:insert">;
        e.queueInsert(p.item as QueueItem, p.position);
        break;
      }
      case "queue:jump":
        e.queueJump((payload as CommandPayload<"queue:jump">).uid);
        break;
      case "queue:reload":
        e.queueReload();
        break;
      case "insert_request": {
        const p = payload as CommandPayload<"insert_request">;
        e.insertRequest(p.item as QueueItem, p.target);
        break;
      }
      case "play_now":
        e.playNow((payload as CommandPayload<"play_now">).item as QueueItem);
        break;
      case "voice_over": {
        const p = payload as CommandPayload<"voice_over">;
        e.voiceOverStart(p.item as QueueItem, p.duckDb);
        break;
      }
      case "replay_last":
        e.replayLast();
        break;
      case "live:start": {
        const p = payload as CommandPayload<"live:start">;
        e.liveStart(p);
        if (p.source === "studio") this.liveServer.allow(p.token);
        else if (p.source === "icecast") {
          const url =
            p.input ??
            `http://${this.config.icecast.host}:${this.config.icecast.port}${this.config.icecast.liveMount}`;
          this.live.startIngest({ kind: "icecast", url }, this.log);
        } else this.live.startIngest({ kind: "linein", device: p.input ?? "default" }, this.log);
        if (p.record && p.recordPath) {
          const id = this.hub.add(
            {
              kind: "file",
              path: p.recordPath,
              codec: p.recordPath.endsWith(".wav")
                ? "wav"
                : p.recordPath.endsWith(".mp3")
                  ? "mp3"
                  : "flac",
            },
            { restartOnExit: false },
          ).id;
          this.recording = { id, path: p.recordPath };
        }
        break;
      }
      case "live:stop": {
        const ended = e.liveStop();
        this.liveServer.allow(null);
        let recordedPath: string | null = null;
        if (this.recording) {
          await this.hub.remove(this.recording.id);
          recordedPath = existsSync(this.recording.path) ? this.recording.path : null;
          this.recording = null;
        }
        return { ...ended, recordedPath };
      }
      case "live:set_gain":
        e.liveSetGain((payload as CommandPayload<"live:set_gain">).gainDb);
        break;
      case "live:set_mode":
        e.liveSetMode((payload as CommandPayload<"live:set_mode">).mode);
        break;
      case "event:start": {
        const p = payload as CommandPayload<"event:start">;
        e.eventStart({ ...p, items: p.items as QueueItem[] });
        break;
      }
      case "event:stop":
        e.eventStop((payload as CommandPayload<"event:stop">).id);
        break;
      case "emergency:trigger":
        e.triggerEmergency((payload as CommandPayload<"emergency:trigger">).reason || "manual");
        break;
      case "emergency:clear":
        e.clearEmergency();
        break;
      case "fader:set":
        e.setFader((payload as CommandPayload<"fader:set">).value);
        break;
      case "monitor:set":
        e.setMonitor((payload as CommandPayload<"monitor:set">).enabled);
        break;
      case "trigger:fire": {
        const p = payload as CommandPayload<"trigger:fire">;
        const simple: Record<string, () => void> = {
          skip: () => e.skip(),
          pause: () => e.pause(),
          resume: () => e.resume(),
          replay_last: () => e.replayLast(),
          emergency: () => e.triggerEmergency("trigger"),
          emergency_clear: () => e.clearEmergency(),
        };
        const fn = simple[p.action];
        if (!fn) throw new Error(`unknown trigger action ${p.action}`);
        fn();
        break;
      }
      case "settings:reload":
        this.reloadSettings();
        break;
      case "stereotool:reload":
        await this.reloadStereoTool();
        return this.stereotool.status();
      case "studio:manual":
        e.setManual((payload as CommandPayload<"studio:manual">).enabled);
        break;
      case "studio:load": {
        const p = payload as CommandPayload<"studio:load">;
        e.studioLoad(p.player, (p.item as QueueItem | undefined) ?? null, p.queueUid, p.cuePoint);
        break;
      }
      case "studio:play":
      case "studio:pause":
      case "studio:stop":
      case "studio:eject":
        e.studioCommand(
          (payload as CommandPayload<"studio:play">).player,
          type.slice("studio:".length) as "play" | "pause" | "stop" | "eject",
        );
        break;
      case "studio:seek": {
        const p = payload as CommandPayload<"studio:seek">;
        e.studio.player(p.player).seek(p.position);
        break;
      }
      case "studio:fade": {
        const p = payload as CommandPayload<"studio:fade">;
        e.studio.player(p.player).fade(p.seconds);
        break;
      }
      case "studio:set": {
        const { player, ...opts } = payload as CommandPayload<"studio:set">;
        e.studio.player(player).set(opts);
        break;
      }
      case "studio:cart":
        e.studio.carts.fire((payload as CommandPayload<"studio:cart">).item as QueueItem);
        break;
      case "studio:cart_stop":
        e.studio.carts.stop((payload as CommandPayload<"studio:cart_stop">).uid);
        break;
      case "monitor:allow": {
        const p = payload as CommandPayload<"monitor:allow">;
        this.liveServer.monitor.allow(p.token, { mic: p.mic, rate: p.rate });
        return { listeners: this.liveServer.monitor.listeners };
      }
    }
    return e.getState();
  }
}
