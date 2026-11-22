import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, Plus } from "lucide-react";
import { del, errorMessage, get, patch, post } from "../../lib/api";
import { ago, dateTime } from "../../lib/format";
import type { Role, User } from "../../lib/types";
import {
  Badge,
  Button,
  ConfirmButton,
  Field,
  Input,
  Modal,
  Panel,
  PageHeader,
  Select,
  Table,
  Tabs,
} from "../../components/ui";

const SCOPES = [
  { value: "public:stats", label: "Partner stats" },
  { value: "triggers:fire", label: "Fire triggers (Stream Deck, MIDI)" },
  { value: "playout:control", label: "Playout control" },
  { value: "read", label: "Read playout state" },
];

export default function Users() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"users" | "keys" | "audit">("users");
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [keyName, setKeyName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["triggers:fire"]);
  const [auditFilter, setAuditFilter] = useState("");
  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => get<{ items: User[] }>("/api/admin/users"),
  });
  const keys = useQuery({
    queryKey: ["keys"],
    queryFn: () =>
      get<{
        items: {
          id: number;
          name: string;
          key_prefix: string;
          scopes: string[];
          last_used_at: string | null;
          revoked_at: string | null;
          created_at: string;
        }[];
      }>("/api/admin/api-keys"),
    enabled: tab === "keys",
  });
  const audit = useQuery({
    queryKey: ["audit", auditFilter],
    queryFn: () =>
      get<{
        items: {
          id: number;
          username: string | null;
          action: string;
          entity_type: string | null;
          entity_id: number | null;
          metadata: unknown;
          ip: string | null;
          created_at: string;
        }[];
      }>(
        `/api/admin/audit?limit=200${auditFilter ? `&action=${encodeURIComponent(auditFilter)}` : ""}`,
      ),
    enabled: tab === "audit",
  });
  const update = async (id: number, body: Record<string, unknown>, ok: string) => {
    try {
      await patch(`/api/admin/users/${id}`, body);
      toast.success(ok);
      void qc.invalidateQueries({ queryKey: ["users"] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <>
      <PageHeader
        title="Users & access"
        description="Admins manage everything; operators run playout, media, schedule and requests; DJs go live and control playout."
        actions={
          tab === "users" ? (
            <Button tone="primary" onClick={() => setCreating(true)}>
              <Plus className="size-4" /> Add user
            </Button>
          ) : null
        }
      />
      <div className="mb-3">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "users", label: "Users" },
            { value: "keys", label: "API keys" },
            { value: "audit", label: "Audit log" },
          ]}
        />
      </div>
      {tab === "users" ? (
        <Panel bodyClass="p-0">
          <Table>
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>2FA</th>
                <th>Last sign-in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.data?.items.map((u) => (
                <tr key={u.id} className={u.is_active ? "" : "opacity-50"}>
                  <td>
                    {u.username}
                    <p className="text-xs text-faint">{u.email}</p>
                  </td>
                  <td>
                    <Select
                      value={u.role}
                      onChange={(e) =>
                        update(
                          u.id,
                          { role: e.target.value },
                          `${u.username} is now ${e.target.value}`,
                        )
                      }
                      className="w-32"
                      aria-label={`Role of ${u.username}`}
                    >
                      <option value="admin">Admin</option>
                      <option value="operator">Operator</option>
                      <option value="dj">DJ</option>
                    </Select>
                  </td>
                  <td>{u.totp_enabled ? <Badge tone="good">on</Badge> : <Badge>off</Badge>}</td>
                  <td className="text-sm text-muted">{ago(u.last_login_at)}</td>
                  <td className="text-right">
                    {u.is_active ? (
                      <ConfirmButton
                        size="sm"
                        tone="ghost"
                        onConfirm={async () => {
                          try {
                            await del(`/api/admin/users/${u.id}`);
                            void qc.invalidateQueries({ queryKey: ["users"] });
                            toast.success(`${u.username} deactivated`);
                          } catch (e) {
                            toast.error(errorMessage(e));
                          }
                        }}
                      >
                        Deactivate
                      </ConfirmButton>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() =>
                          update(u.id, { is_active: true }, `${u.username} reactivated`)
                        }
                      >
                        Reactivate
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>
      ) : null}

      {tab === "keys" ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
          <Panel bodyClass="p-0">
            <Table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Scopes</th>
                  <th>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.data?.items.map((k) => (
                  <tr key={k.id} className={k.revoked_at ? "opacity-50" : ""}>
                    <td>
                      {k.name}
                      <p className="text-xs text-faint">{k.key_prefix}_…</p>
                    </td>
                    <td className="text-sm">{k.scopes.join(", ")}</td>
                    <td className="text-sm text-muted">{ago(k.last_used_at)}</td>
                    <td className="text-right">
                      {k.revoked_at ? (
                        <Badge>revoked</Badge>
                      ) : (
                        <ConfirmButton
                          size="sm"
                          tone="ghost"
                          onConfirm={async () => {
                            await del(`/api/admin/api-keys/${k.id}`);
                            void keys.refetch();
                          }}
                        >
                          Revoke
                        </ConfirmButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Panel>
          <Panel title="New API key">
            <form
              className="flex flex-col gap-3"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  const r = await post<{ key: string }>("/api/admin/api-keys", {
                    name: keyName,
                    scopes,
                  });
                  setNewKey(r.key);
                  setKeyName("");
                  void keys.refetch();
                } catch (err) {
                  toast.error(errorMessage(err));
                }
              }}
            >
              <Field label="Name">
                {(id) => (
                  <Input
                    id={id}
                    value={keyName}
                    onChange={(e) => setKeyName(e.target.value)}
                    required
                    placeholder="e.g. Studio Stream Deck"
                  />
                )}
              </Field>
              <fieldset className="flex flex-col gap-1.5 text-sm">
                <legend className="mb-1 text-muted">Scopes</legend>
                {SCOPES.map((s) => (
                  <label key={s.value} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="accent-tally"
                      checked={scopes.includes(s.value)}
                      onChange={(e) =>
                        setScopes((x) =>
                          e.target.checked ? [...x, s.value] : x.filter((y) => y !== s.value),
                        )
                      }
                    />
                    {s.label}
                  </label>
                ))}
              </fieldset>
              <Button type="submit" tone="primary" disabled={scopes.length === 0}>
                Create key
              </Button>
            </form>
          </Panel>
        </div>
      ) : null}

      {tab === "audit" ? (
        <Panel bodyClass="p-0">
          <div className="border-b border-line p-3">
            <Input
              placeholder="Filter by action prefix, e.g. playout. or settings."
              value={auditFilter}
              onChange={(e) => setAuditFilter(e.target.value)}
              className="max-w-sm"
              aria-label="Filter audit log"
            />
          </div>
          <Table>
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th>Details</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {audit.data?.items.map((a) => (
                <tr key={a.id}>
                  <td className="whitespace-nowrap text-sm">{dateTime(a.created_at)}</td>
                  <td className="text-sm">{a.username ?? "system"}</td>
                  <td className="text-sm">{a.action}</td>
                  <td className="max-w-md truncate text-xs text-muted">
                    {a.metadata ? JSON.stringify(a.metadata) : ""}
                  </td>
                  <td className="text-xs text-faint">{a.ip}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>
      ) : null}

      <Modal open={newKey !== null} onClose={() => setNewKey(null)} title="Copy your API key">
        <p className="mb-3 text-sm text-muted">
          This is the only time the full key is shown. Store it somewhere safe.
        </p>
        <div className="flex gap-2">
          <Input
            readOnly
            value={newKey ?? ""}
            onFocus={(e) => e.target.select()}
            aria-label="API key"
          />
          <Button
            onClick={() => {
              void navigator.clipboard.writeText(newKey ?? "");
              toast.success("Copied");
            }}
          >
            <Copy className="size-4" /> Copy
          </Button>
        </div>
      </Modal>
      <CreateUser
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => void qc.invalidateQueries({ queryKey: ["users"] })}
      />
    </>
  );
}

function CreateUser({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({ username: "", email: "", role: "dj" as Role, password: "" });
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} onClose={onClose} title="Add user">
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await post("/api/admin/users", form);
            toast.success(`Added ${form.username}`);
            onCreated();
            onClose();
            setForm({ username: "", email: "", role: "dj", password: "" });
          } catch (err) {
            toast.error(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Username">
          {(id) => (
            <Input
              id={id}
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              required
              pattern="[a-zA-Z0-9._-]{3,40}"
            />
          )}
        </Field>
        <Field label="Email">
          {(id) => (
            <Input
              id={id}
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              required
            />
          )}
        </Field>
        <Field label="Role">
          {(id) => (
            <Select
              id={id}
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
            >
              <option value="dj">DJ</option>
              <option value="operator">Operator</option>
              <option value="admin">Admin</option>
            </Select>
          )}
        </Field>
        <Field
          label="Temporary password"
          hint="At least 12 characters. Ask them to change it after signing in."
        >
          {(id) => (
            <Input
              id={id}
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              required
              minLength={12}
              autoComplete="new-password"
            />
          )}
        </Field>
        <Button type="submit" tone="primary" busy={busy}>
          Add user
        </Button>
      </form>
    </Modal>
  );
}
