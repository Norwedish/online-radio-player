/**
 * Playout engine (PLAN §6.4 / M4.4–M4.6): the scheduler state machine
 *
 *   IDLE → AUTOPLAY → (LIVE | EVENT | INTERRUPT | EMERGENCY) → AUTOPLAY
 *
 * It keeps a queue spanning the current and next hour plans, applies the
 * boundary rules from @radio/core on every 100 ms tick and at every track end,
 * drives decks on the mixer buses, detects silence, and emits worker events.
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { decideBoundary, nextHourBoundaryMs, stationNow, type BoundaryDecision } from "@radio/core";
import type {
  BoundaryLogEntry,
  LiveStatus,
  PlayoutMode,
  PlayoutState,
  QueueItem,
  WorkerAlert,
  WorkerEventType,
} from "@radio/shared";
import { Deck } from "./audio/deck.js";
import type { Mixer } from "./audio/mixer.js";
import type { PlanSource } from "./scheduler/plan-source.js";

export interface EngineOptions {
  source: PlanSource;
  mixer: Mixer;
  now?: () => number;
  toleranceSeconds: number;
  silenceThresholdDb: number;
  silenceSeconds: number;
  emergencyFile: string;
  /** Auto-recover from silence/emergency after this long (0 = manual only). */
  autoRecoverSeconds?: number;
  log?: (msg: string) => void;
  alert?: (a: WorkerAlert) => void;
  /** Run the 100 ms scheduler tick on a timer (tests drive `tick()` manually). */
  autoTick?: boolean;
  /** Extra status providers (encoders, Stereo Tool) merged into the state. */
  status?: () => Pick<PlayoutState, "encoders" | "stereotool">;
}

interface Playing {
  item: QueueItem;
  deck: Deck;
  startedAt: number;
}

const PRELOAD_SECONDS = 8;
const HISTORY_SIZE = 25;

export class PlayoutEngine extends EventEmitter {
  private readonly source: PlanSource;
  private readonly mixer: Mixer;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private readonly alert: (a: WorkerAlert) => void;
  toleranceSeconds: number;
  silenceThresholdDb: number;
  silenceSeconds: number;
  private readonly startedAt = Date.now();

  mode: PlayoutMode = "idle";
  paused = false;
  stopped = true;
  monitor = false;
  queue: QueueItem[] = [];
  history: QueueItem[] = [];
  current: Playing | null = null;
  private preloaded: { item: QueueItem; deck: Deck } | null = null;
  private fading = new Set<Deck>();
  private voiceOver: Playing | null = null;
  private eventState: {
    id: number;
    title: string;
    priority: number;
    savedQueue: QueueItem[];
  } | null = null;
  private interrupted = false;
  live: LiveStatus = {
    active: false,
    mode: "duck",
    source: null,
    userId: null,
    sessionId: null,
    startedAt: null,
    recording: false,
    gainDb: 0,
    inputPeakDb: -120,
  };
  private takeoverSaved: { item: QueueItem; position: number; boundaryAt: number } | null = null;
  emergency: { active: boolean; reason: string | null; since: number | null; deck: Deck | null } = {
    active: false,
    reason: null,
    since: null,
    deck: null,
  };
  private loadedHours = new Set<string>();
  private lastHourCheck = 0;
  private missingPlanAlerted = new Set<string>();
  boundaryLog: BoundaryLogEntry[] = [];
  private loggedBoundaries = new Set<string>();
  private silentSince: number | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private currentPlan: { planId: number | null; date: string | null; hour: number | null } = {
    planId: null,
    date: null,
    hour: null,
  };
  private lastRecoverAttempt = 0;
  private readonly autoRecoverSeconds: number;

  constructor(private readonly opts: EngineOptions) {
    super();
    this.source = opts.source;
    this.mixer = opts.mixer;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.alert = opts.alert ?? (() => {});
    this.toleranceSeconds = opts.toleranceSeconds;
    this.silenceThresholdDb = opts.silenceThresholdDb;
    this.silenceSeconds = opts.silenceSeconds;
    this.autoRecoverSeconds = opts.autoRecoverSeconds ?? 60;
  }

  private send(type: WorkerEventType, payload: unknown): void {
    this.emit("worker-event", type, payload);
  }

  /* ── Lifecycle ─────────────────────────────────────────────────────── */

  start(): void {
    this.stopped = false;
    this.mode = "autoplay";
    this.validateEmergency();
    this.resync();
    this.tick();
    if (this.opts.autoTick !== false) this.tickTimer = setInterval(() => this.tick(), 100);
  }

  shutdown(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    for (const d of [
      this.current?.deck,
      this.preloaded?.deck,
      this.voiceOver?.deck,
      this.emergency.deck,
      ...this.fading,
    ])
      d?.stop();
  }

  validateEmergency(): boolean {
    const ok = existsSync(this.opts.emergencyFile) || this.source.emergencyItems().length > 0;
    if (!ok)
      this.alert({
        type: "emergency_file_missing",
        severity: "critical",
        message: `Emergency loop file missing: ${this.opts.emergencyFile} (a generated tone will be used)`,
      });
    return ok;
  }

  /* ── Queue management ─────────────────────────────────────────────── */

  private hourKey(date: string, hour: number): string {
    return `${date}:${hour}`;
  }

  private excludeIds(): Set<number> {
    return new Set(
      [...this.queue, ...this.history.slice(0, 10)]
        .map((i) => i.mediaId)
        .filter((id): id is number => id !== null),
    );
  }

  /** Makes sure the current and next hour plans are in the queue. */
  ensureQueue(force = false): void {
    const now = this.now();
    if (!force && now - this.lastHourCheck < 2000) return;
    this.lastHourCheck = now;
    const tz = this.source.timezone();
    const clock = stationNow(tz, now);
    const next = stationNow(tz, nextHourBoundaryMs(tz, now));
    for (const [i, h] of [clock, next].entries()) {
      const key = this.hourKey(h.date, h.hour);
      if (this.loadedHours.has(key)) continue;
      const plan = this.source.hourItems(h.date, h.hour);
      if (!plan) {
        if (i === 0 && this.queue.filter((q) => q.source === "automation").length < 2) {
          // No plan for the on-air hour: keep the station on air with random library music.
          const fill = this.source.fallbackMusic(15, this.excludeIds());
          if (fill.length) {
            this.queue.push(...fill);
            this.loadedHours.add(key);
          }
          if (!this.missingPlanAlerted.has(key)) {
            this.missingPlanAlerted.add(key);
            this.alert({
              type: "plan_missing",
              severity: "error",
              message: `No plan for ${h.date} ${h.hour}:00 — playing fallback music`,
              details: { date: h.date, hour: h.hour },
            });
          }
        }
        continue;
      }
      this.loadedHours.add(key);
      const fresh = plan.items.filter(
        (it) => (it.plannedStart ?? 0) + it.duration * 1000 > now - (i === 0 ? 0 : 1e12),
      );
      // Insert in planned order, after any items planned earlier.
      for (const item of fresh) {
        const idx = this.queue.findIndex(
          (q) =>
            q.plannedStart !== null &&
            item.plannedStart !== null &&
            q.plannedStart > item.plannedStart,
        );
        if (idx === -1) this.queue.push(item);
        else this.queue.splice(idx, 0, item);
      }
    }
    if (this.loadedHours.size > 6) this.loadedHours = new Set([...this.loadedHours].slice(-4));
  }

  /** Rebuilds the automation part of the queue at "now" (start, resume after takeover/event/emergency). */
  resync(): void {
    const now = this.now();
    const manual = this.queue.filter((q) => q.source !== "automation");
    this.queue = manual;
    this.loadedHours.clear();
    this.ensureQueue(true);
    // Drop stale automation items; join an in-progress item at the right offset.
    const keep: QueueItem[] = [];
    let joined = false;
    for (const item of this.queue) {
      if (item.source !== "automation" || item.plannedStart === null) {
        keep.push(item);
        continue;
      }
      const end = item.plannedStart + item.duration * 1000;
      if (end <= now) continue;
      if (!joined && item.plannedStart < now) {
        const offset = (now - item.plannedStart) / 1000;
        joined = true;
        if (!item.locked && offset > item.duration - 10) continue;
        // Locked items more than `tol` late are skipped (news is stale).
        if (item.locked && offset > this.toleranceSeconds) continue;
        keep.push({
          ...item,
          cueIn: item.cueIn + offset,
          duration: item.duration - offset,
          plannedStart: now,
          locked: false,
        });
        continue;
      }
      keep.push(item);
    }
    this.queue = keep;
    this.send("queue", { items: this.queue });
  }

  /* ── Tick / boundary rules ────────────────────────────────────────── */

  private pendingLocked(): QueueItem | null {
    const now = this.now();
    const horizon = now + 3_600_000;
    return (
      this.queue.find((q) => q.locked && q.plannedStart !== null && q.plannedStart < horizon) ??
      null
    );
  }

  tick(): void {
    if (this.stopped) return;
    this.ensureQueue();
    this.checkAutoRecover();
    if (this.emergency.active || this.paused) return;
    if (this.live.active && this.live.mode === "takeover") return;
    const now = this.now();

    // Preload the next deck so transitions are gapless.
    if (
      this.current &&
      this.queue[0] &&
      (!this.preloaded || this.preloaded.item.uid !== this.queue[0].uid) &&
      this.current.deck.remaining < PRELOAD_SECONDS
    ) {
      this.preloaded?.deck.stop();
      const deck = this.makeDeck(this.queue[0]);
      deck.load(0);
      this.preloaded = { item: this.queue[0], deck };
    }

    const locked = this.pendingLocked();
    const playing =
      this.current &&
      (this.current.deck.state === "playing" || this.current.deck.state === "loading")
        ? this.current
        : null;
    const decision = decideBoundary({
      now,
      boundaryAt: locked?.plannedStart ?? null,
      toleranceSeconds: this.toleranceSeconds,
      current: playing
        ? { locked: playing.item.locked, endsAt: now + playing.deck.remaining * 1000 }
        : null,
      next: this.queue[0] ? { locked: this.queue[0].locked, kind: this.queue[0].kind } : null,
      override: this.live.active || this.eventState !== null,
    });
    this.apply(decision, locked);
  }

  private apply(decision: BoundaryDecision, locked: QueueItem | null): void {
    switch (decision.action) {
      case "continue":
      case "wait":
        return;
      case "start_next": {
        const next = this.queue.shift();
        if (next) this.startItem(next);
        return;
      }
      case "fill": {
        if (!locked) {
          // Queue ran dry: fallback music.
          const fill = this.source.fallbackMusic(5, this.excludeIds());
          if (fill.length) {
            this.queue.push(...fill);
            this.startItem(this.queue.shift()!);
          }
          return;
        }
        const filler = this.source.filler(
          decision.gapSeconds + this.toleranceSeconds,
          this.excludeIds(),
        );
        if (filler && filler.duration > 0) {
          this.startItem({ ...filler, source: "automation" });
          return;
        }
        // Nothing fits: start the locked item early rather than dead air.
        this.startLocked(locked, true, {
          action: "early_news",
          deviationMs: -decision.gapSeconds * 1000,
          details: { reason: "no filler" },
        });
        return;
      }
      case "start_locked":
        if (locked) this.startLocked(locked, decision.skipUnlocked, decision.log);
        return;
      case "cut_and_start_locked":
        if (locked && this.current) {
          const old = this.current;
          this.fadeOut(old.deck, decision.fadeMs);
          this.finishCurrent("cut");
          this.startLocked(locked, true, decision.log);
        }
        return;
      case "overridden":
        if (locked?.plannedStart) this.logBoundary(locked, decision.log);
        return;
    }
  }

  private startLocked(
    item: QueueItem,
    skipUnlocked: boolean,
    log: {
      action: BoundaryLogEntry["action"];
      deviationMs: number;
      details: Record<string, unknown>;
    },
  ): void {
    const idx = this.queue.findIndex((q) => q.uid === item.uid);
    if (idx > 0 && skipUnlocked) {
      // Stale music before the lock is dropped (requests/manual items are kept after the news).
      const before = this.queue.slice(0, idx);
      const keep = before.filter((q) => q.source !== "automation");
      this.queue = [...this.queue.slice(idx), ...keep];
    }
    const i = this.queue.findIndex((q) => q.uid === item.uid);
    if (i >= 0) this.queue.splice(i, 1);
    this.logBoundary(item, log);
    this.startItem(item);
  }

  private logBoundary(
    item: QueueItem,
    log: {
      action: BoundaryLogEntry["action"];
      deviationMs: number;
      details: Record<string, unknown>;
    },
  ): void {
    const key = `${item.planItemId ?? item.uid}`;
    if (this.loggedBoundaries.has(key)) return;
    this.loggedBoundaries.add(key);
    if (this.loggedBoundaries.size > 200)
      this.loggedBoundaries = new Set([...this.loggedBoundaries].slice(-100));
    const entry: BoundaryLogEntry = {
      at: this.now(),
      boundaryAt: item.plannedStart ?? this.now(),
      action: log.action,
      deviationMs: Math.round(log.deviationMs),
      details: { ...log.details, title: item.title },
      planId: item.planId,
    };
    this.boundaryLog.unshift(entry);
    this.boundaryLog = this.boundaryLog.slice(0, 50);
    this.send("boundary", entry);
  }

  /* ── Decks ────────────────────────────────────────────────────────── */

  private makeDeck(item: QueueItem): Deck {
    return new Deck(
      {
        path: item.path,
        cueIn: item.cueIn,
        duration: item.duration > 0 ? item.duration : null,
        fadeIn: item.fadeIn,
        fadeOut: item.fadeOut,
        gainDb: item.gainDb,
      },
      item.uid,
    );
  }

  private fadeOut(deck: Deck, ms: number): void {
    this.fading.add(deck);
    deck.fadeTo(0, ms);
    deck.once("faded", () => {
      this.mixer.decks.automation.delete(deck);
      this.mixer.decks.event.delete(deck);
      this.fading.delete(deck);
      deck.stop();
    });
  }

  startItem(
    item: QueueItem,
    offset = 0,
    bus: "automation" | "event" = this.eventState ? "event" : "automation",
  ): void {
    if (this.current) this.finishCurrent("replaced");
    let deck: Deck;
    if (this.preloaded?.item.uid === item.uid && offset === 0) {
      deck = this.preloaded.deck;
      this.preloaded = null;
    } else {
      deck = this.makeDeck(item);
      deck.load(offset);
    }
    deck.play();
    this.mixer.decks[bus].add(deck);
    const playing: Playing = { item, deck, startedAt: this.now() - offset * 1000 };
    this.current = playing;
    deck.once("ended", () => this.onDeckEnded(playing));
    deck.once("error", (e: Error) => {
      this.log(`deck error ${item.path}: ${e.message}`);
      this.alert({
        type: "deck_error",
        severity: "warning",
        message: `Cannot play "${item.title || item.path}": ${e.message}`,
        details: { mediaId: item.mediaId },
      });
      this.onDeckEnded(playing);
    });
    if (item.planId && item.planId !== this.currentPlan.planId && item.locked) {
      const clock = stationNow(this.source.timezone(), this.now());
      this.currentPlan = { planId: item.planId, date: clock.date, hour: clock.hour };
    } else if (item.planId && this.currentPlan.planId === null) {
      const clock = stationNow(this.source.timezone(), this.now());
      this.currentPlan = { planId: item.planId, date: clock.date, hour: clock.hour };
    }
    if (this.mode === "autoplay" && this.interrupted) this.mode = "interrupt";
    this.send("track_started", {
      item,
      startedAt: new Date(playing.startedAt).toISOString(),
      offset,
    });
    this.send("now_playing", this.nowPlaying());
    this.send("queue", { items: this.queue });
  }

  private onDeckEnded(playing: Playing): void {
    if (this.current !== playing) return;
    this.finishCurrent("ended");
    if (this.interrupted && playing.item.source === "manual") {
      this.interrupted = false;
      if (this.mode === "interrupt") this.mode = "autoplay";
    }
    if (this.eventState && this.queue.length === 0) this.endEvent();
    this.tick();
  }

  private finishCurrent(reason: "ended" | "skipped" | "cut" | "replaced" | "stopped"): void {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    if (reason !== "cut") {
      this.mixer.decks.automation.delete(cur.deck);
      this.mixer.decks.event.delete(cur.deck);
      if (reason !== "ended") cur.deck.stop();
    }
    this.history.unshift(cur.item);
    this.history = this.history.slice(0, HISTORY_SIZE);
    this.send("track_ended", {
      item: cur.item,
      endedAt: new Date(this.now()).toISOString(),
      reason,
      playedSeconds: cur.deck.position,
    });
  }

  /* ── Silence detection / emergency (M4.6) ─────────────────────────── */

  /** Called by the audio clock after each rendered block. */
  onRendered(rmsDb: number, frames: number): void {
    const intentional =
      this.stopped || this.paused || (this.live.active && this.live.mode === "takeover");
    if (this.emergency.active || intentional || rmsDb > this.silenceThresholdDb) {
      this.silentSince = null;
      return;
    }
    const now = this.now();
    this.silentSince ??= now - frames / 48;
    if (now - this.silentSince >= this.silenceSeconds * 1000) {
      this.silentSince = null;
      this.triggerEmergency("silence");
    }
  }

  triggerEmergency(reason: string): void {
    if (this.emergency.active) return;
    this.log(`EMERGENCY: ${reason}`);
    this.emergency = { active: true, reason, since: this.now(), deck: null };
    this.mode = "emergency";
    this.mixer.busMute.automation = true;
    this.mixer.busMute.event = true;
    const fromPlaylist = this.source.emergencyItems()[0];
    const path = existsSync(this.opts.emergencyFile)
      ? this.opts.emergencyFile
      : (fromPlaylist?.path ??
        "lavfi:aevalsrc=0.05*sin(2*PI*440*t)*lt(mod(t\\,2)\\,0.3)|0.05*sin(2*PI*440*t)*lt(mod(t\\,2)\\,0.3):s=48000");
    const deck = new Deck({
      path,
      cueIn: 0,
      duration: null,
      fadeIn: 0.5,
      fadeOut: 0,
      gainDb: 0,
      loop: !path.startsWith("lavfi:"),
    });
    deck.load(0);
    deck.play();
    deck.on("error", (e: Error) => this.log(`emergency deck error: ${e.message}`));
    this.mixer.decks.emergency.add(deck);
    this.emergency.deck = deck;
    this.alert({
      type: reason === "silence" ? "dead_air" : "emergency",
      severity: "critical",
      message: `Emergency mode: ${reason}`,
      details: { reason },
    });
    this.send("state", this.getState());
  }

  clearEmergency(): void {
    if (!this.emergency.active) return;
    this.emergency.deck?.stop();
    if (this.emergency.deck) this.mixer.decks.emergency.delete(this.emergency.deck);
    this.emergency = { active: false, reason: null, since: null, deck: null };
    this.mixer.busMute.automation = false;
    this.mixer.busMute.event = false;
    this.mode = this.live.active ? "live" : this.eventState ? "event" : "autoplay";
    this.silentSince = null;
    // The silent deck is likely broken: drop it and continue from the plan.
    if (this.current) this.finishCurrent("skipped");
    this.resync();
    this.tick();
    this.send("state", this.getState());
  }

  private checkAutoRecover(): void {
    if (!this.emergency.active || !this.autoRecoverSeconds) return;
    if (this.emergency.reason === "manual") return;
    const now = this.now();
    if (now - (this.emergency.since ?? now) < this.autoRecoverSeconds * 1000) return;
    if (now - this.lastRecoverAttempt < this.autoRecoverSeconds * 1000) return;
    this.lastRecoverAttempt = now;
    this.log("emergency: attempting automatic recovery");
    this.clearEmergency();
  }

  /* ── Commands ─────────────────────────────────────────────────────── */

  play(): void {
    if (!this.stopped && !this.paused) return;
    this.stopped = false;
    this.paused = false;
    if (this.mode === "idle") this.mode = "autoplay";
    if (!this.tickTimer && this.opts.autoTick !== false) this.start();
    else {
      this.resync();
      this.tick();
    }
  }

  pause(): void {
    if (this.paused || this.stopped) return;
    this.paused = true;
    this.current?.deck.pause();
    this.send("state", this.getState());
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.current?.deck.resume();
    this.tick();
    this.send("state", this.getState());
  }

  stop(): void {
    this.stopped = true;
    this.paused = false;
    if (this.current) this.finishCurrent("stopped");
    this.preloaded?.deck.stop();
    this.preloaded = null;
    this.mode = "idle";
    this.send("state", this.getState());
  }

  skip(): void {
    if (!this.current) {
      this.tick();
      return;
    }
    const old = this.current;
    this.fadeOut(old.deck, 100);
    this.finishCurrent("cut");
    this.tick();
  }

  seek(position: number): void {
    if (!this.current) throw new Error("nothing playing");
    if (position >= this.current.item.duration) throw new Error("position beyond end of item");
    this.current.deck.seek(position);
    this.current.startedAt = this.now() - position * 1000;
    this.send("now_playing", this.nowPlaying());
  }

  queueRemove(uid: string): void {
    const idx = this.queue.findIndex((q) => q.uid === uid);
    if (idx === -1) throw new Error("item not in queue");
    if (this.queue[idx]!.locked) throw new Error("locked items (news) cannot be removed");
    this.queue.splice(idx, 1);
    if (this.preloaded?.item.uid === uid) {
      this.preloaded.deck.stop();
      this.preloaded = null;
    }
    this.send("queue", { items: this.queue });
  }

  queueMove(uid: string, toIndex: number): void {
    const idx = this.queue.findIndex((q) => q.uid === uid);
    if (idx === -1) throw new Error("item not in queue");
    const [item] = this.queue.splice(idx, 1);
    if (item!.locked) {
      this.queue.splice(idx, 0, item!);
      throw new Error("locked items (news) cannot be moved");
    }
    this.queue.splice(Math.min(toIndex, this.queue.length), 0, item!);
    this.send("queue", { items: this.queue });
  }

  queueInsert(item: QueueItem, position: "next" | "end" | number): void {
    const idx =
      position === "next"
        ? 0
        : position === "end"
          ? this.queue.length
          : Math.min(position, this.queue.length);
    this.queue.splice(idx, 0, item);
    this.send("queue", { items: this.queue });
  }

  queueJump(uid: string): void {
    const idx = this.queue.findIndex((q) => q.uid === uid);
    if (idx === -1) throw new Error("item not in queue");
    const item = this.queue[idx]!;
    // Skip everything before it except locked items (news stays in place).
    const skipped = this.queue.slice(0, idx).filter((q) => q.locked);
    this.queue = [{ ...item, locked: false }, ...skipped, ...this.queue.slice(idx + 1)];
    this.skip();
  }

  queueReload(): void {
    const tz = this.source.timezone();
    const nextHour = nextHourBoundaryMs(tz, this.now());
    this.queue = this.queue.filter(
      (q) => q.source !== "automation" || q.plannedStart === null || q.plannedStart < nextHour,
    );
    const clock = stationNow(tz, this.now());
    this.loadedHours = new Set([this.hourKey(clock.date, clock.hour)]);
    this.ensureQueue(true);
    this.send("queue", { items: this.queue });
  }

  insertRequest(item: QueueItem, target: "play_next" | "next_hour"): void {
    const req = { ...item, source: "request" as const };
    if (target === "play_next") {
      this.queue.unshift(req);
    } else {
      const nextHour = nextHourBoundaryMs(this.source.timezone(), this.now());
      const newsIdx = this.queue.findIndex((q) => q.locked && (q.plannedStart ?? 0) >= nextHour);
      this.queue.splice(newsIdx === -1 ? this.queue.length : newsIdx + 1, 0, req);
    }
    this.send("queue", { items: this.queue });
  }

  /** Interrupt / play-now: the interrupted track resumes afterwards from where it was. */
  playNow(item: QueueItem): void {
    if (this.current && !this.current.item.locked) {
      const pos = this.current.deck.position;
      const rest = this.current.item;
      if (rest.duration - pos > 10) {
        this.queue.unshift({
          ...rest,
          uid: randomUUID(),
          cueIn: rest.cueIn + pos,
          duration: rest.duration - pos,
          fadeIn: 0.3,
          plannedStart: null,
          locked: false,
          source: rest.source === "automation" ? "manual" : rest.source,
        });
      }
      const old = this.current;
      this.fadeOut(old.deck, 150);
      this.finishCurrent("cut");
    }
    this.interrupted = true;
    this.mode = "interrupt";
    this.startItem({ ...item, source: "manual" });
  }

  voiceOverStart(item: QueueItem, duckDb?: number): void {
    this.voiceOverStop();
    const deck = this.makeDeck(item);
    deck.load(0);
    deck.play();
    this.mixer.decks.voiceover.add(deck);
    if (duckDb !== undefined) this.mixer.duckDb = duckDb;
    this.voiceOver = { item, deck, startedAt: this.now() };
    this.mixer.duckRequested = true;
    deck.once("ended", () => this.voiceOverStop());
    this.send("state", this.getState());
  }

  voiceOverStop(): void {
    if (!this.voiceOver) return;
    this.mixer.decks.voiceover.delete(this.voiceOver.deck);
    this.voiceOver.deck.stop();
    this.voiceOver = null;
    this.mixer.duckRequested = this.live.active && this.live.mode === "duck";
    this.send("state", this.getState());
  }

  replayLast(): void {
    const last = this.history.find((h) => h.mediaId !== null && h.kind !== "news");
    if (!last) throw new Error("nothing to replay");
    this.playNow({ ...last, uid: randomUUID(), plannedStart: null, locked: false });
  }

  liveStart(opts: {
    mode: "duck" | "takeover";
    source: "studio" | "icecast" | "linein";
    userId: number | null;
    sessionId: number | null;
    record: boolean;
  }): void {
    if (this.live.active) throw new Error("a live session is already active");
    this.live = {
      ...this.live,
      active: true,
      mode: opts.mode,
      source: opts.source,
      userId: opts.userId,
      sessionId: opts.sessionId,
      startedAt: this.now(),
      recording: opts.record,
    };
    this.mixer.live.reset();
    this.mixer.live.active = true;
    this.mode = "live";
    if (opts.mode === "takeover") this.enterTakeover();
    else this.mixer.duckRequested = true;
    this.send("live:status", this.live);
    this.send("state", this.getState());
  }

  private enterTakeover(): void {
    if (this.current) {
      const pos = this.current.deck.position;
      this.takeoverSaved = {
        item: this.current.item,
        position: pos,
        boundaryAt: this.pendingLocked()?.plannedStart ?? Number.POSITIVE_INFINITY,
      };
      this.current.deck.pause();
    }
    this.mixer.duckRequested = false;
  }

  private leaveTakeover(): void {
    const saved = this.takeoverSaved;
    this.takeoverSaved = null;
    if (this.current && saved && this.now() < saved.boundaryAt) {
      // Live ended before the next locked item: resume the paused track.
      this.current.deck.resume();
      return;
    }
    // Crossed a boundary: do not resume a stale track; jump to the plan.
    if (this.current) this.finishCurrent("skipped");
    this.resync();
  }

  liveSetMode(mode: "duck" | "takeover"): void {
    if (!this.live.active || this.live.mode === mode) return;
    this.live.mode = mode;
    if (mode === "takeover") this.enterTakeover();
    else {
      this.leaveTakeover();
      this.mixer.duckRequested = true;
    }
    this.send("live:status", this.live);
  }

  liveSetGain(db: number): void {
    this.live.gainDb = db;
    this.mixer.live.setGainDb(db);
    this.send("live:status", this.live);
  }

  liveStop(): LiveStatus {
    const ended = { ...this.live };
    if (!this.live.active) return ended;
    const wasTakeover = this.live.mode === "takeover";
    this.mixer.live.active = false;
    this.mixer.live.stopIngest();
    this.live = {
      ...this.live,
      active: false,
      source: null,
      userId: null,
      sessionId: null,
      startedAt: null,
      recording: false,
      inputPeakDb: -120,
    };
    this.mixer.duckRequested = this.voiceOver !== null;
    this.mode = this.eventState ? "event" : this.emergency.active ? "emergency" : "autoplay";
    if (wasTakeover) this.leaveTakeover();
    this.tick();
    this.send("live:status", this.live);
    this.send("state", this.getState());
    return ended;
  }

  eventStart(ev: { id: number; title: string; priority: number; items: QueueItem[] }): void {
    if (this.eventState && this.eventState.priority >= ev.priority)
      throw new Error(
        `event "${this.eventState.title}" (priority ${this.eventState.priority}) is active`,
      );
    const saved = this.eventState?.savedQueue ?? this.queue;
    if (this.current) {
      const old = this.current;
      this.fadeOut(old.deck, 200);
      this.finishCurrent("cut");
    }
    this.eventState = { id: ev.id, title: ev.title, priority: ev.priority, savedQueue: saved };
    this.queue = ev.items.map((i) => ({
      ...i,
      source: "event" as const,
      locked: false,
      plannedStart: null,
    }));
    this.mode = "event";
    this.send("state", this.getState());
    this.tick();
  }

  eventStop(id?: number): void {
    if (!this.eventState || (id !== undefined && id !== this.eventState.id)) return;
    if (this.current) {
      const old = this.current;
      this.fadeOut(old.deck, 200);
      this.finishCurrent("cut");
    }
    this.endEvent();
    this.tick();
  }

  private endEvent(): void {
    if (!this.eventState) return;
    const ev = this.eventState;
    this.queue = ev.savedQueue.filter((q) => q.source !== "automation");
    this.eventState = null;
    this.mode = this.live.active ? "live" : "autoplay";
    this.send("alert", {
      type: "event_ended",
      severity: "info",
      message: `Event "${ev.title}" ended`,
      details: { eventId: ev.id },
    });
    this.resync();
    this.send("state", this.getState());
  }

  setFader(value: number): void {
    this.mixer.fader = value;
    this.send("state", this.getState());
  }

  setMonitor(enabled: boolean): void {
    this.monitor = enabled;
  }

  /* ── State ─────────────────────────────────────────────────────────── */

  nowPlaying(): PlayoutState["nowPlaying"] {
    if (!this.current) return null;
    return {
      ...this.current.item,
      startedAt: this.current.startedAt,
      position: Math.round(this.current.deck.position * 10) / 10,
    };
  }

  getState(): PlayoutState {
    this.live.inputPeakDb =
      this.mixer.live.peak > 0 ? Math.round(20 * Math.log10(this.mixer.live.peak) * 10) / 10 : -120;
    const extra = this.opts.status?.() ?? {
      encoders: [],
      stereotool: {
        enabled: false,
        running: false,
        bypassed: true,
        mode: "none",
        edition: null,
        restarts: 0,
        error: null,
      },
    };
    return {
      mode: this.mode,
      paused: this.paused,
      stopped: this.stopped,
      nowPlaying: this.nowPlaying(),
      queue: this.queue,
      history: this.history.slice(0, 10),
      fader: this.mixer.fader,
      monitor: this.monitor,
      voiceOver: { active: this.voiceOver !== null, title: this.voiceOver?.item.title ?? null },
      event: {
        active: this.eventState !== null,
        id: this.eventState?.id ?? null,
        title: this.eventState?.title ?? null,
        priority: this.eventState?.priority ?? 0,
      },
      live: this.live,
      emergency: {
        active: this.emergency.active,
        reason: this.emergency.reason,
        since: this.emergency.since,
      },
      encoders: extra.encoders,
      stereotool: extra.stereotool,
      boundaryLog: this.boundaryLog.slice(0, 20),
      currentPlan: this.currentPlan,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      sampleClock: this.mixer.framesMixed,
    };
  }
}
