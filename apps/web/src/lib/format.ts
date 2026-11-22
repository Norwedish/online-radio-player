export function mmss(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "–:––";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function clock(ms: number, timeZone?: string, seconds = true): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
    hour12: false,
    timeZone,
  }).format(ms);
}

export function dateTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return "–";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(new Date(iso));
}

export function ago(iso: string | number | null | undefined): string {
  if (!iso) return "never";
  const s = Math.round((Date.now() - (typeof iso === "number" ? iso : Date.parse(iso))) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

export function bytes(n: number | null | undefined): string {
  if (!n) return "–";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function hourLabel(h: number): string {
  return `${String(h).padStart(2, "0")}:00`;
}

export function trackLine(item: {
  title?: string | null;
  artist?: string | null;
  kind?: string;
}): string {
  if (item.kind === "news") return item.title || "News";
  return [item.artist, item.title].filter(Boolean).join(" – ") || "Untitled";
}
