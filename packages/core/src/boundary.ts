/**
 * Hour/locked-block boundary rules (PLAN §6.4.5, M4.5) as a pure function.
 *
 * `B` is the start of the next locked item (news at :00 / :30). The scheduler
 * calls `decideBoundary` every tick and whenever the current item ends; the
 * decision says what to do and, at a transition, what to log in
 * `boundary_events`.
 */
export type BoundaryLogAction = "cut" | "let_finish" | "early_news" | "late_news" | "none";

export interface BoundaryInput {
  now: number;
  /** Epoch ms when the pending locked item is due; null when none is pending. */
  boundaryAt: number | null;
  toleranceSeconds: number;
  /** Currently playing item, or null when it just ended / nothing is playing. */
  current: { locked: boolean; endsAt: number } | null;
  /** The next queued item (may be the locked item itself). */
  next: { locked: boolean; kind: string } | null;
  /** Live session or event active (rule 7). */
  override: boolean;
}

export type BoundaryDecision =
  | { action: "continue"; log?: undefined }
  | { action: "start_next"; log?: undefined }
  | { action: "wait"; untilMs: number; log?: undefined }
  | { action: "fill"; gapSeconds: number; log?: undefined }
  | { action: "start_locked"; skipUnlocked: boolean; log: BoundaryLog }
  | { action: "cut_and_start_locked"; fadeMs: number; log: BoundaryLog }
  | { action: "overridden"; log: BoundaryLog };

export interface BoundaryLog {
  action: BoundaryLogAction;
  deviationMs: number;
  details: Record<string, unknown>;
}

/** Deviations below this are reported as on time ("none"). */
export const ON_TIME_MS = 250;
export const CUT_FADE_MS = 150;

export function decideBoundary(input: BoundaryInput): BoundaryDecision {
  const { now, boundaryAt: B, current, next, override } = input;
  const tolMs = input.toleranceSeconds * 1000;

  // No locked item pending: plain sequencing.
  if (B === null) {
    if (current) return { action: "continue" };
    return next ? { action: "start_next" } : { action: "fill", gapSeconds: 0 };
  }

  // Rule 7: live/event active across the boundary → do not force news.
  if (override && now >= B) {
    return {
      action: "overridden",
      log: { action: "none", deviationMs: now - B, details: { rule: 7, overridden: true } },
    };
  }

  // A locked item is itself on air: nothing to decide.
  if (current?.locked) return { action: "continue" };

  if (current) {
    if (now < B) return { action: "continue" };
    const overrun = current.endsAt - B;
    // Rule 3/5: overrun within tolerance → let it finish; news starts late at its end.
    if (overrun <= tolMs) return { action: "continue" };
    // Rule 3/5: overrun beyond tolerance → fade 50–250 ms and cut at B.
    return {
      action: "cut_and_start_locked",
      fadeMs: CUT_FADE_MS,
      log: {
        action: "cut",
        deviationMs: now - B,
        details: { rule: 3, overrunMs: Math.round(overrun), toleranceMs: tolMs },
      },
    };
  }

  // Transition point: the current item ended (or nothing is playing).
  const gap = B - now;
  if (next?.locked) {
    if (gap <= 0) {
      const late = -gap;
      return {
        action: "start_locked",
        skipUnlocked: false,
        log:
          late <= ON_TIME_MS
            ? { action: "none", deviationMs: late, details: { rule: 5 } }
            : { action: "late_news", deviationMs: late, details: { rule: 3 } },
      };
    }
    if (gap <= tolMs) {
      // Rules 1 + 2: ended within tolerance before B → start news early.
      return {
        action: "start_locked",
        skipUnlocked: false,
        log:
          gap <= ON_TIME_MS
            ? { action: "none", deviationMs: -gap, details: { rule: 1 } }
            : { action: "early_news", deviationMs: -gap, details: { rule: 2 } },
      };
    }
    // Too early for news: something must fill the gap.
    return { action: "fill", gapSeconds: gap / 1000 };
  }

  // Next is music (or nothing) while a locked item is pending.
  if (gap <= 0) {
    // Boundary already passed (e.g. after a pause): news now, skip stale music.
    return {
      action: "start_locked",
      skipUnlocked: true,
      log: { action: "late_news", deviationMs: -gap, details: { rule: 5, skippedStale: true } },
    };
  }
  if (gap < tolMs) {
    // Rule 4: do not start a new music track with less than `tol` left; start news early.
    return {
      action: "start_locked",
      skipUnlocked: true,
      log: { action: "early_news", deviationMs: -gap, details: { rule: 4 } },
    };
  }
  return next ? { action: "start_next" } : { action: "fill", gapSeconds: gap / 1000 };
}
