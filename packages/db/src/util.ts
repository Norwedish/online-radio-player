/** Small helpers shared by the repositories. All timestamps are stored as UTC ISO strings. */

export function nowIso(): string {
  return new Date().toISOString();
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJson<T>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function bool(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

export function int(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

/** Builds `SET a = @a, b = @b` for the provided (whitelisted) keys. */
export function buildSet<T extends Record<string, unknown>>(
  patch: T,
  allowed: readonly string[],
): { sql: string; params: Record<string, unknown> } {
  const keys = Object.keys(patch).filter((k) => allowed.includes(k) && patch[k] !== undefined);
  const params: Record<string, unknown> = {};
  for (const key of keys) {
    const value = patch[key];
    params[key] = typeof value === "boolean" ? int(value) : value;
  }
  return { sql: keys.map((k) => `${k} = @${k}`).join(", "), params };
}
