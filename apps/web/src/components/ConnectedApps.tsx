import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { del, errorMessage, get, post } from "../lib/api";
import { ago, dateTime } from "../lib/format";
import { QrCode } from "./QrCode";
import { Badge, Button, ConfirmButton, Field, Input, Panel } from "./ui";

interface Device {
  id: number;
  name: string;
  platform: string | null;
  appVersion: string | null;
  status: "active" | "pending";
  createdAt: string;
  lastUsedAt: string | null;
  lastIp: string | null;
  expiresAt: string | null;
  current: boolean;
}

interface Pairing {
  deviceId: number;
  code: string;
  expiresAt: string;
  server: string;
  qr: string;
}

/** Account → Connected apps: pair the remote-control app by QR code and sign devices out. */
export function ConnectedApps({ className }: { className?: string }) {
  const [name, setName] = useState("");
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [now, setNow] = useState(Date.now());
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: () =>
      get<{ items: Device[]; settings: { enabled: boolean; maxDevices: number } }>(
        "/api/auth/devices",
      ),
    // While a pairing code is shown, notice when the app has used it.
    refetchInterval: pairing ? 3000 : false,
  });

  useEffect(() => {
    if (!pairing) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pairing]);

  const pendingDone =
    pairing && devices.data?.items.some((d) => d.id === pairing.deviceId && d.status === "active");
  useEffect(() => {
    if (pendingDone) {
      toast.success("App connected");
      setPairing(null);
    }
  }, [pendingDone]);

  const secondsLeft = pairing
    ? Math.max(0, Math.round((Date.parse(pairing.expiresAt) - now) / 1000))
    : 0;
  const active = devices.data?.items.filter((d) => d.status === "active") ?? [];
  const enabled = devices.data?.settings.enabled ?? true;

  return (
    <Panel title="Connected apps" className={className}>
      <div className="flex flex-col gap-4 text-sm">
        <p className="text-muted">
          Phones and tablets running the remote-control app. Each device signs in with its own token
          and acts with your role ({active.length} of {devices.data?.settings.maxDevices ?? "…"}{" "}
          devices). Changing your password signs all devices out.
        </p>

        {!enabled ? (
          <p className="text-faint">App access is turned off for this station (users.appTokens).</p>
        ) : pairing && secondsLeft > 0 ? (
          <div className="flex flex-wrap items-start gap-4 rounded-md border border-line p-3">
            <QrCode text={pairing.qr} label={`Pairing QR code ${pairing.code}`} />
            <div className="flex min-w-[14rem] flex-1 flex-col gap-2">
              <p>Scan this code with the app, or enter it by hand:</p>
              <p className="font-mono text-2xl tracking-widest">{pairing.code}</p>
              <p className="text-faint">
                Server {pairing.server} · valid for {Math.floor(secondsLeft / 60)}:
                {String(secondsLeft % 60).padStart(2, "0")} · works once
              </p>
              <div>
                <Button size="sm" tone="ghost" onClick={() => setPairing(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                setPairing(
                  await post<Pairing>("/api/auth/devices/pair", { name: name.trim() || undefined }),
                );
                setNow(Date.now());
                setName("");
                void devices.refetch();
              } catch (err) {
                toast.error(errorMessage(err));
              }
            }}
          >
            <Field label="Device name (optional)" className="min-w-[14rem] flex-1">
              {(id) => (
                <Input
                  id={id}
                  value={name}
                  maxLength={80}
                  placeholder="e.g. Studio tablet"
                  onChange={(e) => setName(e.target.value)}
                />
              )}
            </Field>
            <Button type="submit" tone="primary">
              Pair a device
            </Button>
          </form>
        )}

        {active.length ? (
          <ul className="flex flex-col divide-y divide-line">
            {active.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="font-medium">{d.name}</span>
                <span className="text-faint">
                  {[d.platform, d.appVersion && `v${d.appVersion}`].filter(Boolean).join(" ")}
                  {" · "}last used {d.lastUsedAt ? ago(d.lastUsedAt) : "never"}
                  {d.lastIp ? ` from ${d.lastIp}` : ""} · paired {dateTime(d.createdAt)}
                </span>
                {d.current ? <Badge tone="good">this device</Badge> : null}
                <ConfirmButton
                  size="sm"
                  className="ml-auto"
                  confirmLabel="Click again to sign out"
                  onConfirm={async () => {
                    try {
                      await del(`/api/auth/devices/${d.id}`);
                      toast.success(`${d.name} signed out`);
                      void devices.refetch();
                    } catch (err) {
                      toast.error(errorMessage(err));
                    }
                  }}
                >
                  Sign out
                </ConfirmButton>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-faint">No apps connected.</p>
        )}
      </div>
    </Panel>
  );
}
