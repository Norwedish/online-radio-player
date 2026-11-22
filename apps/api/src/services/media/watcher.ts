/**
 * Watch-folder auto-import (M2.5): chokidar on `media.watchFolder`, events
 * debounced for 2 s (and files imported only once their size has settled),
 * then probed/imported through the scanner.
 */
import { existsSync, mkdirSync } from "node:fs";
import { basename, extname } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { Repositories } from "@radio/db";
import type { RuntimeConfig } from "@radio/shared";
import { importFile, isIgnoredName, mediaRoots } from "./scanner.js";

export interface WatcherStatus {
  watching: string[];
  imported: number;
  lastImportAt: string | null;
  pending: number;
  lastError: string | null;
}

export class MediaWatcher {
  private watcher: FSWatcher | null = null;
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private imported = 0;
  private lastImportAt: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly repos: Repositories,
    private readonly config: RuntimeConfig,
    private readonly onImported: (ids: number[]) => void,
    private readonly debounceMs = 2000,
  ) {}

  get status(): WatcherStatus {
    return {
      watching: this.watcher ? [this.config.media.watchFolder] : [],
      imported: this.imported,
      lastImportAt: this.lastImportAt,
      pending: this.pending.size,
      lastError: this.lastError,
    };
  }

  start(): void {
    if (this.watcher) return;
    const dir = this.config.media.watchFolder;
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    } catch (e) {
      this.lastError = `cannot create ${dir}: ${(e as Error).message}`;
      return;
    }
    const exts = new Set(this.config.media.extensions.map((e) => e.toLowerCase()));
    this.watcher = chokidar.watch(dir, {
      ignoreInitial: true,
      ignored: (path: string) => isIgnoredName(basename(path)),
      awaitWriteFinish: { stabilityThreshold: 750, pollInterval: 100 },
    });
    const queue = (path: string) => {
      if (!exts.has(extname(path).toLowerCase())) return;
      this.pending.add(path);
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.flush(), this.debounceMs);
    };
    this.watcher.on("add", queue).on("change", queue);
    this.watcher.on("error", (e) => {
      this.lastError = (e as Error).message;
    });
  }

  /** Imports everything queued so far (exposed for tests). */
  async flush(): Promise<void> {
    if (this.running) await this.running;
    this.timer = null;
    const paths = [...this.pending];
    this.pending.clear();
    if (paths.length === 0) return;
    this.running = (async () => {
      const ids: number[] = [];
      const roots = mediaRoots(this.config);
      for (const path of paths) {
        if (!existsSync(path)) continue;
        try {
          const { row } = await importFile(this.repos, this.config, path, roots);
          ids.push(row.id);
        } catch (e) {
          this.lastError = `${basename(path)}: ${(e as Error).message}`;
        }
      }
      if (ids.length) {
        this.imported += ids.length;
        this.lastImportAt = new Date().toISOString();
        this.onImported(ids);
      }
    })();
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.watcher?.close();
    this.watcher = null;
    if (this.running) await this.running;
  }
}
