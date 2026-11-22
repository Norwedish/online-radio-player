import { z } from "zod";

export const DEFAULT_STATION_TIMEZONE = "Europe/Amsterdam";

export const stationSchema = z.object({
  id: z.number().int().positive().default(1),
  name: z.string().min(1),
  timezone: z.string().min(1).default(DEFAULT_STATION_TIMEZONE),
  locale: z.string().min(2).default("en"),
  logoUrl: z.string().optional(),
  colors: z
    .object({
      primary: z.string().default("#22c55e"),
      background: z.string().default("#0b0f0e"),
    })
    .default({ primary: "#22c55e", background: "#0b0f0e" }),
});

export type Station = z.infer<typeof stationSchema>;

/** Station configuration (M1.1) — see ./config.ts for the full Zod schema. */
export {
  STATION_CONFIG_VERSION,
  stationConfigSchema,
  StationConfig,
  parseStationConfig,
  formatConfigErrors,
  stationConfigCrossFieldIssues,
} from "./config.js";

export const PROJECT_NAME = "online-radio-player";
export const PROJECT_VERSION = "0.1.0";
