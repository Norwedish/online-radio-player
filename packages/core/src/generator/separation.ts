/**
 * SeparationTracker (PLAN M3.2): no repeat of the same track within
 * `trackHours` and the same artist within `artistHours`. Works on absolute
 * epoch-ms timestamps, so it is timezone/DST-agnostic: "4 hours" is always
 * 4 × 3600 s of real time, even across a DST change.
 */
export interface SeparationEntry {
  mediaId: number;
  artist: string | null;
  at: number;
}

export function normalizeArtist(artist: string | null | undefined): string {
  return (artist ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/\s+(feat\.?|ft\.?|featuring|&|and|x)\s+.*$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export class SeparationTracker {
  private readonly byTrack = new Map<number, number[]>();
  private readonly byArtist = new Map<string, number[]>();

  constructor(
    readonly trackHours: number,
    readonly artistHours: number,
    entries: SeparationEntry[] = [],
  ) {
    for (const e of entries) this.add(e.mediaId, e.artist, e.at);
  }

  add(mediaId: number, artist: string | null, at: number): void {
    this.byTrack.set(mediaId, [...(this.byTrack.get(mediaId) ?? []), at]);
    const key = normalizeArtist(artist);
    if (key) this.byArtist.set(key, [...(this.byArtist.get(key) ?? []), at]);
  }

  /** Strictly less than the window is a violation; exactly `trackHours` apart is allowed. */
  trackOk(mediaId: number, at: number): boolean {
    const window = this.trackHours * 3_600_000;
    return !(this.byTrack.get(mediaId) ?? []).some((t) => Math.abs(t - at) < window);
  }

  artistOk(artist: string | null, at: number): boolean {
    const key = normalizeArtist(artist);
    if (!key) return true;
    const window = this.artistHours * 3_600_000;
    return !(this.byArtist.get(key) ?? []).some((t) => Math.abs(t - at) < window);
  }

  canPlay(mediaId: number, artist: string | null, at: number): boolean {
    return this.trackOk(mediaId, at) && this.artistOk(artist, at);
  }

  clone(): SeparationTracker {
    const copy = new SeparationTracker(this.trackHours, this.artistHours);
    for (const [k, v] of this.byTrack) copy.byTrack.set(k, [...v]);
    for (const [k, v] of this.byArtist) copy.byArtist.set(k, [...v]);
    return copy;
  }
}
