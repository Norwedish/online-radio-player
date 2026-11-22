/** Integration helpers: a throwaway Icecast server and stream sampling. */
import { spawn, spawnSync, execFileSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { renderIcecastXml, type StationConfig } from "../../packages/shared/src/index.ts";

export const SOURCE_PASSWORD = "it-source-pw";
export const ADMIN_PASSWORD = "it-admin-pw";

export function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export function icecastBinary(): string | null {
  for (const bin of ["icecast2", "icecast"]) {
    try {
      execFileSync("which", [bin], { stdio: "ignore" });
      return bin;
    } catch {
      // try next
    }
  }
  return null;
}

export class TestIcecast {
  proc: ChildProcess | null = null;
  readonly configFile: string;

  constructor(
    readonly dir: string,
    readonly config: Pick<StationConfig, "station" | "icecast">,
  ) {
    mkdirSync(join(dir, "log"), { recursive: true });
    chmodSync(dir, 0o777);
    chmodSync(join(dir, "log"), 0o777);
    const share = existsSync("/usr/share/icecast2") ? "/usr/share/icecast2" : "/usr/share/icecast";
    const xml = renderIcecastXml(
      config,
      { sourcePassword: SOURCE_PASSWORD, adminPassword: ADMIN_PASSWORD },
      {
        basedir: dir,
        logdir: join(dir, "log"),
        webroot: join(share, "web"),
        adminroot: join(share, "admin"),
      },
      {
        hostname: "127.0.0.1",
        changeOwner: process.getuid?.() === 0 ? { user: "nobody", group: "nogroup" } : undefined,
      },
    );
    this.configFile = join(dir, "icecast.xml");
    writeFileSync(this.configFile, xml);
    chmodSync(this.configFile, 0o644);
  }

  async start(): Promise<void> {
    this.proc = spawn(icecastBinary()!, ["-c", this.configFile], { stdio: "ignore" });
    for (let i = 0; i < 50; i += 1) {
      try {
        const r = await fetch(`http://127.0.0.1:${this.config.icecast.port}/status-json.xsl`);
        if (r.ok) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("icecast did not start");
  }

  async stop(): Promise<void> {
    const p = this.proc;
    this.proc = null;
    if (!p) return;
    await new Promise<void>((resolve) => {
      p.once("exit", () => resolve());
      p.kill("SIGKILL");
    });
  }

  async mounts(): Promise<{ mount: string; listeners: number; type: string }[]> {
    const r = await fetch(`http://127.0.0.1:${this.config.icecast.port}/status-json.xsl`);
    const j = (await r.json()) as { icestats: { source?: unknown } };
    const src = j.icestats.source;
    const list = Array.isArray(src) ? src : src ? [src] : [];
    return list.map((s: Record<string, unknown>) => ({
      mount: String(s.listenurl).replace(/^.*\//, ""),
      listeners: Number(s.listeners),
      type: String(s.server_type),
    }));
  }

  async waitForMounts(names: string[], timeoutMs = 15_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      try {
        const have = (await this.mounts()).map((m) => m.mount);
        if (names.every((n) => have.includes(n))) return;
      } catch {
        // icecast restarting
      }
      if (Date.now() > end) throw new Error(`mounts not up: ${names.join(",")}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** Reads `seconds` of a mount and returns FFmpeg volumedetect numbers. */
  async sample(
    mount: string,
    seconds = 2,
  ): Promise<{ bytes: number; meanDb: number; maxDb: number }> {
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${this.config.icecast.port}/${mount}`, {
      signal: ctrl.signal,
    });
    const chunks: Buffer[] = [];
    const reader = res.body!.getReader();
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    ctrl.abort();
    const data = Buffer.concat(chunks);
    const file = join(this.dir, `sample-${mount}`);
    writeFileSync(file, data);
    const out = spawnSync(
      "ffmpeg",
      ["-hide_banner", "-nostats", "-i", file, "-af", "volumedetect", "-f", "null", "-"],
      { encoding: "utf8" },
    ).stderr;
    const mean = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(out)?.[1];
    const max = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(out)?.[1];
    return {
      bytes: data.length,
      meanDb: mean && mean !== "-inf" ? Number(mean) : -120,
      maxDb: max && max !== "-inf" ? Number(max) : -120,
    };
  }
}
