/**
 * Studio players (manual operation): two on-air players (A/B) the operator
 * loads and drives by hand, plus a cart bank for jingles that may overlap.
 *
 * Each player is a StudioSource on the mixer's studio bus with its own fader
 * and meter. Cuts are de-clicked with short ramps; loops pre-decode the restart
 * so they are (nearly) gapless; auto-next starts the other player when one
 * ends or when a manual fade-out begins (a hand-made crossfade).
 */
import { Meter, dbToGain } from "@radio/core";
import type {
  QueueItem,
  StudioCartState,
  StudioPlayerId,
  StudioPlayerState,
  StudioState,
  WorkerAlert,
} from "@radio/shared";
import { Deck } from "./audio/deck.js";
import type { Mixer, StudioSource } from "./audio/mixer.js";

export interface StudioHooks {
  log: (m: string) => void;
  alert: (a: WorkerAlert) => void;
  /** State changed on its own (end, loop, auto-next, error): broadcast it. */
  changed: () => void;
  /** A player went on air (the engine switches to manual mode). */
  started: (id: StudioPlayerId) => void;
}

/** Short ramp that removes clicks on stop/pause/eject. */
const DECLICK_MS = 40;
const RESUME_MS = 20;
/** Pre-decode the loop restart this long before the end. */
const LOOP_PRELOAD_SECONDS = 3;
const MAX_CARTS = 8;

function makeDeck(item: QueueItem): Deck {
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

function scratchFor(buf: Float32Array, n: number): Float32Array {
  return buf.length >= n ? buf : new Float32Array(n);
}

export class StudioPlayer implements StudioSource {
  item: QueueItem | null = null;
  status: StudioPlayerState["status"] = "empty";
  gainDb = 0;
  cuePoint = 0;
  loop = false;
  autoNext = false;
  fading = false;
  /** Fired when this player ends or starts a fade-out with auto-next on. */
  onNext: (() => void) | null = null;
  private deck: Deck | null = null;
  private loopDeck: Deck | null = null;
  /** Decks ramping out after stop/eject/load (removed once silent). */
  private tails = new Set<Deck>();
  private meter = new Meter();
  private scratch: Float32Array = new Float32Array(0);
  /** Invalidates pending "faded" callbacks when a newer action supersedes them. */
  private token = 0;

  constructor(
    readonly id: StudioPlayerId,
    private readonly hooks: StudioHooks,
  ) {}

  get position(): number {
    return this.deck?.position ?? this.cuePoint;
  }

  /* ── Transport ─────────────────────────────────────────────────────── */

  load(item: QueueItem, cuePoint = 0): void {
    if (this.status === "playing") throw new Error(`player ${this.id} is on air: stop it first`);
    this.retire();
    this.item = item;
    this.cuePoint = this.clampCue(cuePoint);
    this.prepare();
    this.status = "loaded";
    this.fading = false;
  }

  play(): void {
    if (!this.item) throw new Error(`player ${this.id} is empty`);
    if (this.status === "playing") {
      // Play during a fade-out cancels the fade.
      if (this.fading && this.deck) {
        this.token += 1;
        this.fading = false;
        this.deck.fadeTo(1, 200);
      }
      return;
    }
    this.token += 1;
    if (!this.deck) this.prepare();
    const d = this.deck!;
    if (d.state === "paused") {
      d.resume();
      d.fadeTo(1, RESUME_MS);
    } else if (d.state === "playing") {
      // Still ramping down from a pause: bring it back up.
      d.fadeTo(1, RESUME_MS);
    } else {
      if (d.state === "ended" || d.state === "error" || d.state === "idle") this.prepare();
      this.deck!.play();
    }
    this.status = "playing";
    this.fading = false;
    this.hooks.started(this.id);
  }

  pause(): void {
    if (this.status !== "playing" || !this.deck) return;
    const d = this.deck;
    const token = ++this.token;
    this.status = "paused";
    this.fading = false;
    d.fadeTo(0, DECLICK_MS);
    d.once("faded", () => {
      if (token === this.token && this.deck === d) d.pause();
    });
  }

  /** Stop and return to the cue point, ready to play again. */
  stop(): void {
    if (!this.item) throw new Error(`player ${this.id} is empty`);
    this.token += 1;
    this.retire();
    this.prepare();
    this.status = "loaded";
    this.fading = false;
  }

  eject(): void {
    if (this.status === "playing") throw new Error(`player ${this.id} is on air: stop it first`);
    this.token += 1;
    this.retire();
    this.item = null;
    this.status = "empty";
    this.cuePoint = 0;
    this.fading = false;
  }

  seek(position: number): void {
    if (!this.item || !this.deck) throw new Error(`player ${this.id} is empty`);
    const max = this.item.duration > 0 ? this.item.duration - 0.1 : position;
    const pos = Math.max(0, Math.min(position, max));
    if (this.status === "paused") {
      // Keep it paused at the new position.
      this.token += 1;
      this.deck.stop();
      this.deck = makeDeck(this.item);
      this.wire(this.deck);
      this.deck.load(pos);
      return;
    }
    this.deck.seek(pos);
  }

  /** Fade out over `seconds`, then stop at the cue point. Auto-next starts the other player now. */
  fade(seconds: number): void {
    if (this.status !== "playing" || !this.deck)
      throw new Error(`player ${this.id} is not playing`);
    const d = this.deck;
    const token = ++this.token;
    this.fading = true;
    d.fadeTo(0, seconds * 1000);
    d.once("faded", () => {
      if (token !== this.token || this.deck !== d) return;
      this.fading = false;
      d.stop();
      this.deck = null;
      this.prepare();
      this.status = "loaded";
      this.hooks.changed();
    });
    if (this.autoNext) this.onNext?.();
  }

  set(opts: { gainDb?: number; loop?: boolean; cuePoint?: number; autoNext?: boolean }): void {
    if (opts.gainDb !== undefined) this.gainDb = opts.gainDb;
    if (opts.autoNext !== undefined) this.autoNext = opts.autoNext;
    if (opts.loop !== undefined) {
      this.loop = opts.loop;
      if (!opts.loop) this.dropLoopDeck();
    }
    if (opts.cuePoint !== undefined) {
      if (!this.item) throw new Error(`player ${this.id} is empty`);
      this.cuePoint = this.clampCue(opts.cuePoint);
      this.dropLoopDeck();
      // A loaded (not started) player re-cues so Play starts at the new point.
      if (this.status === "loaded") {
        this.retire();
        this.prepare();
      }
    }
  }

  /** Fade out if playing (hand-back to automation); keeps the item loaded. */
  release(seconds: number): void {
    if (this.status === "playing") this.fade(seconds);
    else if (this.status === "paused") this.stop();
  }

  /* ── Mixing ────────────────────────────────────────────────────────── */

  mixInto(out: Float32Array, frames: number): void {
    const n = frames * 2;
    if (!this.deck && this.tails.size === 0) return;
    this.scratch = scratchFor(this.scratch, n);
    const s = this.scratch;
    s.fill(0, 0, n);
    const g = dbToGain(this.gainDb);
    // Deck.mixInto only reads while the deck itself is playing (loaded/paused decks stay silent).
    this.deck?.mixInto(s, frames, g);
    for (const t of this.tails) t.mixInto(s, frames, g);
    this.meter.add(s, n);
    for (let i = 0; i < n; i += 1) out[i] = out[i]! + s[i]!;
    this.maybePreloadLoop();
  }

  readMeter(): { peak: number; rms: number; position: number } {
    return { ...this.meter.read(), position: this.position };
  }

  starving(): boolean {
    const d = this.deck;
    return Boolean(d && d.state === "playing" && !d.ready);
  }

  state(): StudioPlayerState {
    return {
      id: this.id,
      item: this.item,
      status: this.status,
      position: Math.round(this.position * 100) / 100,
      gainDb: this.gainDb,
      cuePoint: this.cuePoint,
      loop: this.loop,
      autoNext: this.autoNext,
      fading: this.fading,
    };
  }

  shutdown(): void {
    this.deck?.stop();
    this.loopDeck?.stop();
    for (const t of this.tails) t.stop();
    this.tails.clear();
  }

  /* ── Internals ─────────────────────────────────────────────────────── */

  private clampCue(cue: number): number {
    const dur = this.item?.duration ?? 0;
    return Math.max(0, dur > 1 ? Math.min(cue, dur - 1) : 0);
  }

  /** Decodes ahead from the cue point so Play starts instantly. */
  private prepare(): void {
    if (!this.item) return;
    this.deck?.stop();
    this.deck = makeDeck(this.item);
    this.wire(this.deck);
    this.deck.load(this.cuePoint);
  }

  /** Moves the current deck out with a de-click ramp (or stops it if silent). */
  private retire(): void {
    this.dropLoopDeck();
    const d = this.deck;
    this.deck = null;
    if (!d) return;
    if (d.state !== "playing") {
      d.stop();
      return;
    }
    this.tails.add(d);
    d.removeAllListeners("ended");
    d.fadeTo(0, DECLICK_MS);
    d.once("faded", () => {
      this.tails.delete(d);
      d.stop();
    });
    d.once("ended", () => this.tails.delete(d));
  }

  private dropLoopDeck(): void {
    this.loopDeck?.stop();
    this.loopDeck = null;
  }

  private maybePreloadLoop(): void {
    const d = this.deck;
    if (!this.loop || !this.item || !d || this.status !== "playing" || this.loopDeck) return;
    if (d.remaining > LOOP_PRELOAD_SECONDS) return;
    this.loopDeck = makeDeck(this.item);
    this.wire(this.loopDeck);
    this.loopDeck.load(this.cuePoint);
  }

  private wire(d: Deck): void {
    d.once("ended", () => this.onEnded(d));
    d.once("error", (e: Error) => {
      if (d !== this.deck && d !== this.loopDeck) return;
      this.hooks.log(`studio ${this.id} deck error ${this.item?.path}: ${e.message}`);
      this.hooks.alert({
        type: "studio_deck_error",
        severity: "warning",
        message: `Player ${this.id} cannot play "${this.item?.title || this.item?.path}": ${e.message}`,
        details: { player: this.id, mediaId: this.item?.mediaId ?? null },
      });
      if (d === this.loopDeck) this.loopDeck = null;
      if (d === this.deck) {
        this.deck = null;
        this.status = this.item ? "loaded" : "empty";
        this.fading = false;
      }
      this.hooks.changed();
    });
  }

  private onEnded(d: Deck): void {
    if (d !== this.deck || this.status !== "playing") return;
    if (this.loop && this.item) {
      const next = this.loopDeck ?? makeDeck(this.item);
      if (!this.loopDeck) {
        this.wire(next);
        next.load(this.cuePoint);
      }
      this.loopDeck = null;
      this.deck = next;
      next.play();
      this.hooks.changed();
      return;
    }
    this.deck = null;
    this.prepare();
    this.status = "loaded";
    this.fading = false;
    if (this.autoNext) this.onNext?.();
    this.hooks.changed();
  }
}

/** Cart pads: fire-and-forget decks that may overlap each other and the music. */
export class CartBank implements StudioSource {
  readonly id = "carts";
  private carts = new Map<string, { item: QueueItem; deck: Deck }>();
  /** Stopped carts ramping out (removed once silent). */
  private tails = new Set<Deck>();
  private meter = new Meter();
  private scratch: Float32Array = new Float32Array(0);

  constructor(private readonly hooks: StudioHooks) {}

  fire(item: QueueItem): string {
    if (this.carts.size >= MAX_CARTS) {
      // Too many at once: drop the oldest.
      const oldest = this.carts.keys().next().value;
      if (oldest) this.stop(oldest);
    }
    const deck = makeDeck(item);
    deck.load(0);
    deck.play();
    this.carts.set(item.uid, { item, deck });
    const done = () => {
      if (this.carts.get(item.uid)?.deck !== deck) return;
      this.carts.delete(item.uid);
      this.hooks.changed();
    };
    deck.once("ended", done);
    deck.once("error", (e: Error) => {
      this.hooks.alert({
        type: "studio_deck_error",
        severity: "warning",
        message: `Cart "${item.title || item.path}" cannot play: ${e.message}`,
        details: { mediaId: item.mediaId },
      });
      done();
    });
    return item.uid;
  }

  stop(uid?: string): void {
    for (const [key, c] of [...this.carts]) {
      if (uid && key !== uid) continue;
      this.carts.delete(key);
      // Keep mixing it until silent, then free it.
      const d = c.deck;
      d.fadeTo(0, 80);
      this.tails.add(d);
      d.once("faded", () => {
        this.tails.delete(d);
        d.stop();
      });
      d.once("ended", () => this.tails.delete(d));
    }
  }

  mixInto(out: Float32Array, frames: number): void {
    if (this.carts.size === 0 && this.tails.size === 0) return;
    const n = frames * 2;
    this.scratch = scratchFor(this.scratch, n);
    const s = this.scratch;
    s.fill(0, 0, n);
    for (const c of [...this.carts.values()]) c.deck.mixInto(s, frames, 1);
    for (const t of this.tails) t.mixInto(s, frames, 1);
    this.meter.add(s, n);
    for (let i = 0; i < n; i += 1) out[i] = out[i]! + s[i]!;
  }

  readMeter(): { peak: number; rms: number; position: number } {
    return { ...this.meter.read(), position: 0 };
  }

  starving(): boolean {
    return [...this.carts.values()].some((c) => c.deck.state === "playing" && !c.deck.ready);
  }

  state(): StudioCartState[] {
    return [...this.carts.values()].map((c) => ({
      uid: c.item.uid,
      mediaId: c.item.mediaId,
      title: c.item.title,
      duration: c.item.duration,
      position: Math.round(c.deck.position * 10) / 10,
    }));
  }

  shutdown(): void {
    for (const c of this.carts.values()) c.deck.stop();
    for (const t of this.tails) t.stop();
    this.carts.clear();
    this.tails.clear();
  }
}

export class Studio {
  readonly players: Record<StudioPlayerId, StudioPlayer>;
  readonly carts: CartBank;

  constructor(mixer: Mixer, hooks: StudioHooks) {
    this.players = { A: new StudioPlayer("A", hooks), B: new StudioPlayer("B", hooks) };
    this.carts = new CartBank(hooks);
    // Auto-next: A hands over to B and back (a loaded or paused partner starts).
    this.players.A.onNext = () => this.startPartner("B");
    this.players.B.onNext = () => this.startPartner("A");
    mixer.studio.push(this.players.A, this.players.B, this.carts);
  }

  player(id: StudioPlayerId): StudioPlayer {
    return this.players[id];
  }

  private startPartner(id: StudioPlayerId): void {
    const p = this.players[id];
    if (p.status === "loaded" || p.status === "paused") p.play();
  }

  /** Hand back to automation: fade out whatever plays (carts finish on their own). */
  release(seconds = 2): void {
    for (const p of Object.values(this.players)) {
      // No auto-next chain while handing back.
      const auto = p.autoNext;
      p.autoNext = false;
      p.release(seconds);
      p.autoNext = auto;
    }
  }

  get playing(): boolean {
    return Object.values(this.players).some((p) => p.status === "playing");
  }

  state(manual: boolean): StudioState {
    return {
      manual,
      players: [this.players.A.state(), this.players.B.state()],
      carts: this.carts.state(),
    };
  }

  shutdown(): void {
    this.players.A.shutdown();
    this.players.B.shutdown();
    this.carts.shutdown();
  }
}
