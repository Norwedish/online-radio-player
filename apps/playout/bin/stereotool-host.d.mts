/** Types for stereotool-host.mjs (plain ESM so it runs unbuilt in dev and production). */
export declare const LOAD_TYPES: Record<
  "totalinit" | "all_settings" | "audiofm" | "audio" | "processing",
  number[]
>;
export declare function loadTypeCandidates(loadType?: string | number): number[];

export interface StereoToolBinding {
  softwareVersion(): number;
  apiVersion(): number;
  setBindIp: ((web: string, uecp: string) => void) | null;
  enableInternalSoundCard: ((enabled: boolean) => void) | null;
  create(key: string | null): unknown;
  create3:
    | ((
        hasGui: boolean,
        key: string | null,
        name: string,
        home: string,
        loadIni: boolean,
      ) => unknown)
    | null;
  destroy(handle: unknown): void;
  loadPreset(handle: unknown, filename: string, type: number): boolean;
  latency(handle: unknown, rate: number, feedSilence: boolean): number;
  licenseValid(handle: unknown): boolean;
  unlicensedFeatures(handle: unknown, text: Uint8Array, maxlen: number): boolean;
  process(
    handle: unknown,
    samples: Float32Array,
    frames: number,
    channels: number,
    rate: number,
  ): void;
}

export declare function bindLibrary(path: string): Promise<StereoToolBinding>;

export interface HostConfig {
  library: string;
  preset?: string;
  loadType?: string | number;
  licenseKeyEnv?: string;
  home?: string;
  rate?: number;
  channels?: number;
}

export declare function openInstance(
  st: StereoToolBinding,
  cfg: HostConfig,
  env?: NodeJS.ProcessEnv,
): { handle: unknown; loadType: number | null; latencySamples: number; rate: number };

export declare function licenseReport(
  st: StereoToolBinding,
  handle: unknown,
): { valid: boolean; unlicensedFeatures: string };

export declare function cString(buf: Uint8Array): string;

export declare class PcmProcessor {
  constructor(process: (samples: Float32Array, frames: number) => void, channels?: number);
  framesProcessed: number;
  push(chunk: Buffer): Buffer;
}

export declare function main(argv?: string[], env?: NodeJS.ProcessEnv): Promise<number>;
