import { describe, expect, it } from "vitest";
import { DEFAULT_STATION_TIMEZONE, stationSchema } from "./index.js";

describe("shared station schema", () => {
  it("applies defaults", () => {
    const station = stationSchema.parse({ name: "Test Radio" });
    expect(station.timezone).toBe(DEFAULT_STATION_TIMEZONE);
    expect(station.locale).toBe("en");
    expect(station.id).toBe(1);
  });

  it("rejects an empty name", () => {
    expect(() => stationSchema.parse({ name: "" })).toThrow();
  });
});
