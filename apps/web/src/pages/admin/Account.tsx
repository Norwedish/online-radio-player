import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "../../hooks/auth";
import { errorMessage, get, post } from "../../lib/api";
import { ago } from "../../lib/format";
import { Badge, Button, Field, Input, Panel, PageHeader } from "../../components/ui";
import { ConnectedApps } from "../../components/ConnectedApps";
import { QrCode } from "../../components/QrCode";

export default function Account() {
  const { user, refresh } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [disablePw, setDisablePw] = useState("");
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: () =>
      get<{
        items: {
          id: number;
          ip: string;
          user_agent: string | null;
          created_at: string;
          current: boolean;
        }[];
      }>("/api/auth/sessions"),
  });

  return (
    <>
      <PageHeader
        title="My account"
        description={`${user?.username} · ${user?.email} · ${user?.role}`}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Password">
          <form
            className="flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await post("/api/auth/password/change", { current, next });
                toast.success("Password changed; other sessions were signed out");
                setCurrent("");
                setNext("");
                void sessions.refetch();
              } catch (err) {
                toast.error(errorMessage(err));
              }
            }}
          >
            <Field label="Current password">
              {(id) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="current-password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  required
                />
              )}
            </Field>
            <Field label="New password" hint="At least 12 characters.">
              {(id) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="new-password"
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                  required
                  minLength={12}
                />
              )}
            </Field>
            <Button type="submit" tone="primary">
              Change password
            </Button>
          </form>
        </Panel>

        <Panel
          title="Two-factor authentication"
          actions={user?.totp_enabled ? <Badge tone="good">on</Badge> : <Badge>off</Badge>}
        >
          {recovery ? (
            <div>
              <p className="mb-2 text-sm">
                Save these recovery codes. Each works once if you lose your phone.
              </p>
              <pre className="rounded-md border border-line bg-desk p-3 text-sm leading-7">
                {recovery.join("\n")}
              </pre>
              <Button
                className="mt-3"
                onClick={() => {
                  void navigator.clipboard.writeText(recovery.join("\n"));
                  toast.success("Copied");
                }}
              >
                Copy codes
              </Button>
            </div>
          ) : user?.totp_enabled ? (
            <form
              className="flex flex-col gap-3"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await post("/api/auth/2fa/disable", { password: disablePw });
                  toast.success("Two-factor authentication turned off");
                  void refresh();
                } catch (err) {
                  toast.error(errorMessage(err));
                }
              }}
            >
              <Field label="Confirm with your password">
                {(id) => (
                  <Input
                    id={id}
                    type="password"
                    value={disablePw}
                    onChange={(e) => setDisablePw(e.target.value)}
                    required
                  />
                )}
              </Field>
              <Button type="submit" tone="danger">
                Turn off two-factor
              </Button>
            </form>
          ) : setup ? (
            <form
              className="flex flex-col gap-3"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  const r = await post<{ recoveryCodes: string[] }>("/api/auth/2fa/enable", {
                    code,
                  });
                  setRecovery(r.recoveryCodes);
                  void refresh();
                } catch (err) {
                  toast.error(errorMessage(err));
                }
              }}
            >
              <p className="text-sm text-muted">
                Scan the QR code with your authenticator app (or enter the key below), then enter
                the 6-digit code.
              </p>
              <QrCode text={setup.otpauthUrl} size={180} label="Authenticator QR code" />
              <code className="break-all rounded-md border border-line bg-desk p-2 text-sm">
                {setup.secret}
              </code>
              <a href={setup.otpauthUrl} className="text-sm text-tally hover:underline">
                Open in authenticator app
              </a>
              <Field label="6-digit code">
                {(id) => (
                  <Input
                    id={id}
                    inputMode="numeric"
                    pattern="\d{6}"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    required
                  />
                )}
              </Field>
              <Button type="submit" tone="primary">
                Turn on two-factor
              </Button>
            </form>
          ) : (
            <>
              <p className="mb-3 text-sm text-muted">
                Protect your account with a code from an authenticator app at every sign-in.
              </p>
              <Button
                onClick={async () => {
                  try {
                    setSetup(await post("/api/auth/2fa/setup"));
                  } catch (err) {
                    toast.error(errorMessage(err));
                  }
                }}
              >
                Set up two-factor
              </Button>
            </>
          )}
        </Panel>

        <Panel
          title="Signed-in sessions"
          className="lg:col-span-2"
          actions={
            <Button
              size="sm"
              onClick={async () => {
                const r = await post<{ revoked: number }>("/api/auth/logout-all");
                toast.success(`Signed out ${r.revoked} other session(s)`);
                void sessions.refetch();
              }}
            >
              Sign out everywhere else
            </Button>
          }
        >
          <ul className="flex flex-col gap-2 text-sm">
            {sessions.data?.items.map((s) => (
              <li key={s.id} className="flex flex-wrap gap-2">
                <span className="truncate">{s.user_agent ?? "Unknown browser"}</span>
                <span className="text-faint">
                  · {s.ip} · {ago(s.created_at)}
                </span>
                {s.current ? <Badge tone="good">this browser</Badge> : null}
              </li>
            ))}
          </ul>
        </Panel>

        <ConnectedApps className="lg:col-span-2" />
      </div>
    </>
  );
}
