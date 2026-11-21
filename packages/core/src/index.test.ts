import { describe, expect, it } from "vitest";
import {
  DEFAULT_BOUNDARY_TOLERANCE_SECONDS,
  DEFAULT_NEWS_BLOCKS,
  GENERATOR_DEFAULTS,
} from "./index.js";

describe("playout constants", () => {
  it("uses a 45 second boundary tolerance by default", () => {
    expect(DEFAULT_BOUNDARY_TOLERANCE_SECONDS).toBe(45);
  });

  it("keeps news locked at :00 and :30", () => {
    expect(DEFAULT_NEWS_BLOCKS.map((block) => block.startMinute)).toEqual([0, 30]);
  });

  it("matches the playlist_maker separation defaults", () => {
    expect(GENERATOR_DEFAULTS.separationTrackHours).toBe(4);
    expect(GENERATOR_DEFAULTS.separationArtistHours).toBe(1);
  });
});
