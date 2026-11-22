import { useEffect, useMemo, useState, type ReactNode } from "react";
import { NavLink, Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Activity,
  AlarmClock,
  Bell,
  CalendarClock,
  Gauge,
  Headphones,
  Library,
  ListMusic,
  LogOut,
  Menu,
  MessageSquareText,
  Mic,
  Radio,
  Settings,
  Siren,
  UserCog,
  Users,
} from "lucide-react";
import { useAuth } from "../hooks/auth";
import { applyState, startLive, stopLive, useLive } from "../hooks/live";
import { get, post, errorMessage } from "../lib/api";
import type { Permission, PlayoutState } from "../lib/types";
import { StudioClock } from "./meters";
import { Button, Spinner, cx } from "./ui";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading)
    return (
      <div className="p-10">
        <Spinner />
      </div>
    );
  if (!user)
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  return <>{children}</>;
}

const NAV: { to: string; label: string; icon: typeof Radio; perm: Permission }[] = [
  { to: "/admin", label: "Dashboard", icon: Gauge, perm: "playout:view" },
  { to: "/admin/playout", label: "Playout", icon: Radio, perm: "playout:view" },
  { to: "/admin/live", label: "Live studio", icon: Mic, perm: "live:broadcast" },
  { to: "/admin/schedule", label: "Schedule", icon: CalendarClock, perm: "schedule:view" },
  { to: "/admin/playlists", label: "Playlists", icon: ListMusic, perm: "media:view" },
  { to: "/admin/media", label: "Media library", icon: Library, perm: "media:view" },
  { to: "/admin/requests", label: "Requests", icon: MessageSquareText, perm: "requests:moderate" },
  { to: "/admin/events", label: "Events", icon: AlarmClock, perm: "schedule:view" },
  { to: "/admin/stats", label: "Stats", icon: Activity, perm: "stats:view" },
  { to: "/admin/alerts", label: "Alerts", icon: Bell, perm: "alerts:view" },
  { to: "/admin/users", label: "Users", icon: Users, perm: "users:manage" },
  { to: "/admin/settings", label: "Settings", icon: Settings, perm: "settings:view" },
];

/** Next locked item (news) start, or the next :00/:30. */
export function nextBoundary(state: PlayoutState | null): number | null {
  const locked = state?.queue.find((q) => q.locked && q.plannedStart);
  if (locked?.plannedStart) return locked.plannedStart;
  const d = new Date();
  const next = new Date(d);
  next.setSeconds(0, 0);
  next.setMinutes(d.getMinutes() < 30 ? 30 : 60);
  return next.getTime();
}

export function AdminShell() {
  const { user, logout, can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const state = useLive((s) => s.state);
  const connected = useLive((s) => s.connected);
  const workerConnected = useLive((s) => s.workerConnected);
  const listeners = useLive((s) => s.listeners);
  const lastAlert = useLive((s) => s.lastAlert);
  const alertTick = useLive((s) => s.alertTick);
  const location = useLocation();

  useEffect(() => {
    startLive();
    void get<{ state: PlayoutState | null }>("/api/playout/state")
      .then((r) => applyState(r.state))
      .catch(() => {});
    return () => stopLive();
  }, []);
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (lastAlert && (lastAlert.severity === "critical" || lastAlert.severity === "error"))
      toast.error(lastAlert.message);
  }, [lastAlert]);

  const station = useQuery({
    queryKey: ["settings-station"],
    queryFn: () => get<{ station: { name: string; timezone: string } }>("/api/settings"),
    enabled: can("settings:view"),
    staleTime: 60_000,
  });
  const pub = useQuery({
    queryKey: ["public-np"],
    queryFn: () => get<{ station: { name: string; timezone: string } }>("/api/public/now-playing"),
    staleTime: 60_000,
  });
  const alerts = useQuery({
    queryKey: ["alerts-active", alertTick],
    queryFn: () => get<{ activeCount: number }>("/api/alerts?active=true&limit=1"),
    enabled: can("alerts:view"),
  });
  const tz =
    station.data?.station.timezone ??
    pub.data?.station.timezone ??
    Intl.DateTimeFormat().resolvedOptions().timeZone;
  const name = station.data?.station.name ?? pub.data?.station.name ?? "Radio";
  const boundary = useMemo(() => nextBoundary(state), [state]);

  const clearEmergency = async () => {
    try {
      applyState(
        (await post<{ state: PlayoutState }>("/api/playout/emergency", { action: "clear" })).state,
      );
      toast.success("Automation resumed");
      void qc.invalidateQueries({ queryKey: ["alerts-active"] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[220px_1fr]">
      <aside
        className={cx(
          "fixed inset-y-0 left-0 z-40 w-[220px] border-r border-line bg-panel transition-transform lg:static lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-14 items-center gap-2.5 border-b border-line px-4">
          <span className="size-3 rounded-full bg-tally" aria-hidden />
          <span className="truncate font-display text-xl font-semibold tracking-wide">{name}</span>
        </div>
        <nav className="flex flex-col gap-0.5 p-2" aria-label="Main">
          {NAV.filter((n) => can(n.perm)).map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/admin"}
              className={({ isActive }) =>
                cx(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm",
                  isActive
                    ? "bg-panel-2 text-legend"
                    : "text-muted hover:bg-panel-2/60 hover:text-legend",
                )
              }
            >
              <n.icon className="size-4" aria-hidden />
              {n.label}
              {n.to === "/admin/alerts" && (alerts.data?.activeCount ?? 0) > 0 ? (
                <span className="ml-auto rounded bg-clip px-1.5 text-xs text-white tnum">
                  {alerts.data!.activeCount}
                </span>
              ) : null}
            </NavLink>
          ))}
        </nav>
        <div className="absolute inset-x-0 bottom-0 border-t border-line p-3">
          <NavLink
            to="/admin/account"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted hover:text-legend"
          >
            <UserCog className="size-4" aria-hidden />
            <span className="truncate">{user?.username}</span>
            <span className="ml-auto text-xs capitalize text-faint">{user?.role}</span>
          </NavLink>
          <button
            type="button"
            className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted hover:text-legend"
            onClick={async () => {
              await logout();
              navigate("/login");
            }}
          >
            <LogOut className="size-4" aria-hidden /> Sign out
          </button>
          <a
            href="/listen"
            className="mt-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted hover:text-legend"
          >
            <Headphones className="size-4" aria-hidden /> Listener page
          </a>
        </div>
      </aside>
      {open ? (
        <button
          type="button"
          aria-label="Close menu"
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          onClick={() => setOpen(false)}
        />
      ) : null}

      <div className="min-w-0">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-4 border-b border-line bg-desk/95 px-4 backdrop-blur">
          <button
            type="button"
            className="rounded p-1.5 text-muted lg:hidden"
            aria-label="Open menu"
            onClick={() => setOpen(true)}
          >
            <Menu className="size-5" />
          </button>
          <StudioClock
            timeZone={tz}
            nextBoundaryMs={boundary}
            onAir={Boolean(state && !state.stopped && !state.paused)}
            live={Boolean(state?.live.active)}
          />
          <div className="ml-auto flex items-center gap-4 text-sm">
            <span className="hidden text-muted md:inline">
              <span className="font-display text-lg text-legend tnum">{listeners}</span> listening
            </span>
            <span
              className={cx(
                "inline-flex items-center gap-1.5",
                workerConnected && connected ? "text-muted" : "text-clip",
              )}
              title="Playout worker connection"
            >
              <span
                className={cx(
                  "size-2 rounded-full",
                  workerConnected && connected ? "bg-signal" : "bg-clip",
                )}
              />
              <span className="hidden sm:inline">
                {!connected ? "Console offline" : workerConnected ? "Engine" : "Engine down"}
              </span>
            </span>
          </div>
        </header>
        {state?.emergency.active ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 border-b border-clip bg-clip/15 px-4 py-2.5 text-sm"
          >
            <Siren className="size-5 text-clip" aria-hidden />
            <span>
              <strong>Emergency loop on air</strong> ({state.emergency.reason}). Automation is
              muted.
            </span>
            {can("playout:control") ? (
              <Button size="sm" tone="live" className="ml-auto" onClick={clearEmergency}>
                Resume automation
              </Button>
            ) : null}
          </div>
        ) : null}
        <main className="mx-auto max-w-[1400px] p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
