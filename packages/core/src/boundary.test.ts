import { describe, expect, it } from "vitest";
import { decideBoundary, type BoundaryInput } from "./boundary.js";

const B = 1_000_000_000;
const s = (x: number) => x * 1000;
const base: BoundaryInput = {
  now: B,
  boundaryAt: B,
  toleranceSeconds: 45,
  current: null,
  next: { locked: true, kind: "news" },
  override: false,
};
const music = { locked: false, kind: "music" };

describe("hour boundary rules (§6.4.5)", () => {
  it.each([
    // [label, input overrides, expected action, expected log action]
    [
      "rule 2: ends 30 s early → news starts early",
      { now: B - s(30) },
      "start_locked",
      "early_news",
    ],
    [
      "rule 2: ends exactly tol early → early news",
      { now: B - s(45) },
      "start_locked",
      "early_news",
    ],
    ["rule 2: ends 60 s early → gap must be filled", { now: B - s(60) }, "fill", undefined],
    ["rule 5: exactly at B → on time", { now: B }, "start_locked", "none"],
    [
      "rule 3: overrun within tol ended 20 s late → late news",
      { now: B + s(20) },
      "start_locked",
      "late_news",
    ],
  ] as const)("%s", (_label, patch, action, log) => {
    const d = decideBoundary({ ...base, ...patch });
    expect(d.action).toBe(action);
    expect(d.log?.action).toBe(log);
  });

  it("rule 3: overrun within tolerance → keep playing past B", () => {
    expect(
      decideBoundary({ ...base, now: B + s(1), current: { locked: false, endsAt: B + s(40) } })
        .action,
    ).toBe("continue");
  });

  it("rule 3/5: overrun beyond tolerance → fade 50–250 ms and cut at B", () => {
    const d = decideBoundary({ ...base, now: B, current: { locked: false, endsAt: B + s(46) } });
    expect(d.action).toBe("cut_and_start_locked");
    if (d.action === "cut_and_start_locked") {
      expect(d.fadeMs).toBeGreaterThanOrEqual(50);
      expect(d.fadeMs).toBeLessThanOrEqual(250);
      expect(d.log.action).toBe("cut");
    }
  });

  it("before B a playing track always continues", () => {
    expect(
      decideBoundary({ ...base, now: B - s(10), current: { locked: false, endsAt: B + s(200) } })
        .action,
    ).toBe("continue");
  });

  it("rule 4: no new music track with < tol before B → news early, skip music", () => {
    const d = decideBoundary({ ...base, now: B - s(30), next: music });
    expect(d.action).toBe("start_locked");
    if (d.action === "start_locked") {
      expect(d.skipUnlocked).toBe(true);
      expect(d.log.action).toBe("early_news");
      expect(d.log.deviationMs).toBe(-s(30));
    }
  });

  it("music with enough time before B starts normally", () => {
    expect(decideBoundary({ ...base, now: B - s(200), next: music }).action).toBe("start_next");
  });

  it("rule 7: live/event override suppresses the forced transition", () => {
    const d = decideBoundary({
      ...base,
      now: B + s(5),
      override: true,
      current: { locked: false, endsAt: B + s(600) },
    });
    expect(d.action).toBe("overridden");
  });

  it("a locked item already on air is never cut", () => {
    expect(
      decideBoundary({ ...base, now: B + s(100), current: { locked: true, endsAt: B + s(500) } })
        .action,
    ).toBe("continue");
  });

  it("no pending lock → plain sequencing", () => {
    expect(decideBoundary({ ...base, boundaryAt: null, next: music }).action).toBe("start_next");
    expect(
      decideBoundary({ ...base, boundaryAt: null, current: { locked: false, endsAt: B } }).action,
    ).toBe("continue");
  });
});
