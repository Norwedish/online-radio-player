/** RBAC permission matrix (PLAN 5.6 / M7.3). Enforced server-side on every route. */

export const ROLES = ["admin", "dj", "operator"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "playout:view",
  "playout:control",
  "live:broadcast",
  "live:manage",
  "media:view",
  "media:manage",
  "playlists:manage",
  "schedule:view",
  "schedule:manage",
  "requests:moderate",
  "events:manage",
  "stats:view",
  "alerts:view",
  "alerts:ack",
  "users:manage",
  "settings:view",
  "settings:manage",
  "apikeys:manage",
  "audit:view",
  "recordings:manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const OPERATOR: Permission[] = [
  "playout:view",
  "playout:control",
  "live:manage",
  "media:view",
  "media:manage",
  "playlists:manage",
  "schedule:view",
  "schedule:manage",
  "requests:moderate",
  "events:manage",
  "stats:view",
  "alerts:view",
  "alerts:ack",
  "recordings:manage",
];

const DJ: Permission[] = [
  "playout:view",
  "playout:control",
  "live:broadcast",
  "media:view",
  "schedule:view",
  "requests:moderate",
  "stats:view",
  "alerts:view",
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: PERMISSIONS,
  operator: OPERATOR,
  dj: DJ,
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** API key scopes for partners and hardware triggers (M7.7). */
export const API_KEY_SCOPES = ["public:stats", "triggers:fire", "playout:control", "read"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
