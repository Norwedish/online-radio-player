/** Minimal Prometheus text-format registry (PLAN M12.2): counters + gauges with labels. */

type Labels = Record<string, string | number>;

function key(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map(
      (k) =>
        `${k}="${String(labels[k]).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`,
    )
    .join(",");
}

export class Metrics {
  private counters = new Map<string, Map<string, number>>();
  private gauges = new Map<string, Map<string, number>>();
  private help = new Map<string, string>();
  private collectors: (() => void)[] = [];

  describe(name: string, help: string): void {
    this.help.set(name, help);
  }

  inc(name: string, labels: Labels = {}, by = 1): void {
    const m = this.counters.get(name) ?? new Map<string, number>();
    const k = key(labels);
    m.set(k, (m.get(k) ?? 0) + by);
    this.counters.set(name, m);
  }

  set(name: string, value: number, labels: Labels = {}): void {
    const m = this.gauges.get(name) ?? new Map<string, number>();
    m.set(key(labels), value);
    this.gauges.set(name, m);
  }

  resetGauge(name: string): void {
    this.gauges.delete(name);
  }

  /** Collectors refresh gauges right before a scrape. */
  collect(fn: () => void): void {
    this.collectors.push(fn);
  }

  render(): string {
    for (const c of this.collectors) {
      try {
        c();
      } catch {
        // a failing collector never breaks the scrape
      }
    }
    const lines: string[] = [];
    const emit = (type: "counter" | "gauge", map: Map<string, Map<string, number>>) => {
      for (const [name, series] of [...map.entries()].sort()) {
        lines.push(`# HELP ${name} ${this.help.get(name) ?? name}`);
        lines.push(`# TYPE ${name} ${type}`);
        for (const [labels, value] of series)
          lines.push(`${name}${labels ? `{${labels}}` : ""} ${Number.isFinite(value) ? value : 0}`);
      }
    };
    emit("counter", this.counters);
    emit("gauge", this.gauges);
    return `${lines.join("\n")}\n`;
  }
}
