import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../hooks/auth";
import { ApiError, api, errorMessage } from "../../lib/api";
import type { User } from "../../lib/types";
import { Button, Field, Input } from "../../components/ui";

function AuthFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="size-3 rounded-full bg-tally" aria-hidden />
          <span className="font-display text-xl font-semibold tracking-wide">Studio</span>
        </div>
        <div className="rounded-lg border border-line bg-panel p-6">
          <h1 className="mb-5 font-display text-2xl font-semibold">{title}</h1>
          {children}
        </div>
      </div>
    </main>
  );
}

export function LoginPage() {
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ user: User }>("/api/auth/login", {
        method: "POST",
        body: { login, password, totp: needTotp ? totp : undefined },
      });
      setUser(res.user);
      const next = params.get("next");
      navigate(next && next.startsWith("/admin") ? next : "/admin", { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === "totp_required") setNeedTotp(true);
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title={needTotp ? "Two-factor code" : "Sign in"}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        {!needTotp ? (
          <>
            <Field label="Username or email">
              {(id) => (
                <Input
                  id={id}
                  autoComplete="username"
                  value={login}
                  onChange={(e) => setLogin(e.target.value)}
                  required
                  autoFocus
                />
              )}
            </Field>
            <Field label="Password">
              {(id) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              )}
            </Field>
          </>
        ) : (
          <Field label="Code from your authenticator app" hint="A recovery code also works.">
            {(id) => (
              <Input
                id={id}
                inputMode="numeric"
                autoComplete="one-time-code"
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
                required
                autoFocus
              />
            )}
          </Field>
        )}
        {error ? (
          <p role="alert" className="text-sm text-clip">
            {error}
          </p>
        ) : null}
        <Button type="submit" tone="primary" busy={busy} size="lg">
          {needTotp ? "Verify" : "Sign in"}
        </Button>
        <Link to="/forgot-password" className="text-center text-sm text-muted hover:text-legend">
          Forgot your password?
        </Link>
      </form>
    </AuthFrame>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <AuthFrame title="Reset password">
      {sent ? (
        <p className="text-sm text-muted">
          If an account uses that address, a reset link is on its way. It works for one hour.
        </p>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            await api("/api/auth/password/forgot", { method: "POST", body: { email } }).catch(
              () => {},
            );
            setSent(true);
            setBusy(false);
          }}
        >
          <Field label="Email">
            {(id) => (
              <Input
                id={id}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            )}
          </Field>
          <Button type="submit" tone="primary" busy={busy}>
            Send reset link
          </Button>
        </form>
      )}
      <Link to="/login" className="mt-4 block text-center text-sm text-muted hover:text-legend">
        Back to sign in
      </Link>
    </AuthFrame>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <AuthFrame title="Choose a new password">
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api("/api/auth/password/reset", {
              method: "POST",
              body: { token: params.get("token"), password },
            });
            navigate("/login");
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="New password" hint="At least 12 characters.">
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={12}
              autoFocus
            />
          )}
        </Field>
        {error ? <p className="text-sm text-clip">{error}</p> : null}
        <Button type="submit" tone="primary" busy={busy}>
          Save password
        </Button>
      </form>
    </AuthFrame>
  );
}
