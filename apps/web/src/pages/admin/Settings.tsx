import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "../../hooks/auth";
import { del, errorMessage, get, patch, post, put } from "../../lib/api";
import { bytes, dateTime } from "../../lib/format";
import {
  Badge,
  Button,
  Field,
  InfoTip,
  Input,
  Panel,
  PageHeader,
  Select,
  Table,
  Tabs,
  Textarea,
  Toggle,
} from "../../components/ui";

interface SettingRow {
  key: string;
  value: unknown;
  category: string;
  label: string;
  /** Plain-language explanation (ⓘ tooltip). */
  help?: string;
  reloadsWorker: boolean;
}

type Tab =
  | "station"
  | "audio"
  | "live"
  | "requests"
  | "retention"
  | "alerts"
  | "outputs"
  | "triggers"
  | "backups";

export default function Settings() {
  const { can } = useAuth();
  const manage = can("settings:manage");
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("station");
  const data = useQuery({
    queryKey: ["settings"],
    queryFn: () =>
      get<{
        station: {
          name: string;
          timezone: string;
          locale: string;
          logo_url: string | null;
          colors: Record<string, string>;
        };
        settings: SettingRow[];
      }>("/api/settings"),
  });
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [station, setStation] = useState<{
    name: string;
    timezone: string;
    logo_url: string;
    primary: string;
    background: string;
  }>({ name: "", timezone: "", logo_url: "", primary: "#22c55e", background: "#0b0f0e" });
  useEffect(() => {
    if (!data.data) return;
    setDraft(Object.fromEntries(data.data.settings.map((s) => [s.key, s.value])));
    const st = data.data.station;
    setStation({
      name: st.name,
      timezone: st.timezone,
      logo_url: st.logo_url ?? "",
      primary: st.colors.primary ?? "#22c55e",
      background: st.colors.background ?? "#0b0f0e",
    });
  }, [data.data]);

  const save = async (keys: string[]) => {
    const changes = Object.fromEntries(keys.map((k) => [k, draft[k]]));
    try {
      const r = await patch<{ changed: string[]; workerReloaded: boolean }>("/api/settings", {
        settings: changes,
      });
      toast.success(
        r.changed.length
          ? `Saved ${r.changed.length} setting${r.changed.length > 1 ? "s" : ""}${r.workerReloaded ? "; playout reloaded" : ""}`
          : "Nothing changed",
      );
      void qc.invalidateQueries({ queryKey: ["settings"] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const rows = (cat: string) => data.data?.settings.filter((s) => s.category === cat) ?? [];
  const SettingsForm = ({ cat, note }: { cat: string; note?: string }) => (
    <Panel>
      {note ? <p className="mb-4 text-sm text-muted">{note}</p> : null}
      <div className="grid gap-4 md:grid-cols-2">
        {rows(cat).map((s) =>
          typeof s.value === "boolean" ? (
            <Toggle
              key={s.key}
              checked={Boolean(draft[s.key])}
              onChange={(v) => setDraft({ ...draft, [s.key]: v })}
              label={s.label}
              info={s.help}
              disabled={!manage}
            />
          ) : Array.isArray(s.value) ? (
            <Field key={s.key} label={s.label} info={s.help} hint="One per line">
              {(id) => (
                <Textarea
                  id={id}
                  value={((draft[s.key] as string[]) ?? []).join("\n")}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      [s.key]: e.target.value
                        .split("\n")
                        .map((x) => x.trim())
                        .filter(Boolean),
                    })
                  }
                  disabled={!manage}
                />
              )}
            </Field>
          ) : (
            <Field
              key={s.key}
              label={s.label}
              info={s.help}
              hint={s.reloadsWorker ? "Applied to playout immediately" : undefined}
            >
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  step="any"
                  value={String(draft[s.key] ?? "")}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      [s.key]: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                  disabled={!manage}
                />
              )}
            </Field>
          ),
        )}
      </div>
      {manage ? (
        <Button tone="primary" className="mt-5" onClick={() => save(rows(cat).map((r) => r.key))}>
          Save {cat} settings
        </Button>
      ) : null}
    </Panel>
  );

  return (
    <>
      <PageHeader
        title="Settings"
        description="Station identity and the settings you can change while on air. Stereo Tool and Icecast are configured in station.json on the server."
      />
      <div className="mb-4 overflow-x-auto">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "station", label: "Station" },
            { value: "audio", label: "Audio" },
            { value: "live", label: "Live" },
            { value: "requests", label: "Requests" },
            { value: "retention", label: "Retention" },
            { value: "alerts", label: "Alerts" },
            { value: "outputs", label: "Outputs" },
            { value: "triggers", label: "Triggers" },
            { value: "backups", label: "Backups" },
          ]}
        />
      </div>
      {tab === "station" ? (
        <Panel>
          <div className="grid gap-4 md:grid-cols-2">
            <Field
              label="Station name"
              info="Shown on the listener page, the public schedule, the browser tab title and the console header. The name in the stream itself (what radio apps show) and in alert e-mails comes from station.json on the server."
            >
              {(id) => (
                <Input
                  id={id}
                  value={station.name}
                  onChange={(e) => setStation({ ...station, name: e.target.value })}
                  disabled={!manage}
                />
              )}
            </Field>
            <Field
              label="Time zone"
              info="The station's local time. The news at :00 and :30, the hourly schedule, the playlist generator and all times in the console follow this zone, including summer/winter time changes."
              hint="Hours, news and the generator follow this zone."
            >
              {(id) => (
                <Select
                  id={id}
                  value={station.timezone}
                  onChange={(e) => setStation({ ...station, timezone: e.target.value })}
                  disabled={!manage}
                >
                  {Intl.supportedValuesOf("timeZone").map((z) => (
                    <option key={z}>{z}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label="Logo URL"
              info="Image shown next to the station name at the top of the listener page. Use a full https:// address or a path on this server (e.g. /branding/logo.png). Leave empty to show only the name."
            >
              {(id) => (
                <Input
                  id={id}
                  value={station.logo_url}
                  onChange={(e) => setStation({ ...station, logo_url: e.target.value })}
                  placeholder="/branding/logo.png"
                  disabled={!manage}
                />
              )}
            </Field>
            <div className="flex gap-4">
              <Field
                label="Brand colour"
                info="Accent colour of the listener page and public schedule: play button, links and highlights."
              >
                {(id) => (
                  <input
                    id={id}
                    type="color"
                    value={station.primary}
                    onChange={(e) => setStation({ ...station, primary: e.target.value })}
                    disabled={!manage}
                    className="h-9 w-16 rounded border border-line-strong bg-desk"
                  />
                )}
              </Field>
              <Field
                label="Listener page background"
                info="Background colour of the listener page and public schedule. Pick a dark colour so the light text stays readable."
              >
                {(id) => (
                  <input
                    id={id}
                    type="color"
                    value={station.background}
                    onChange={(e) => setStation({ ...station, background: e.target.value })}
                    disabled={!manage}
                    className="h-9 w-16 rounded border border-line-strong bg-desk"
                  />
                )}
              </Field>
            </div>
          </div>
          {manage ? (
            <Button
              tone="primary"
              className="mt-5"
              onClick={async () => {
                try {
                  await patch("/api/settings", {
                    station: {
                      name: station.name,
                      timezone: station.timezone,
                      logo_url: station.logo_url || null,
                      colors: { primary: station.primary, background: station.background },
                    },
                  });
                  toast.success("Station saved");
                  void qc.invalidateQueries();
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            >
              Save station
            </Button>
          ) : null}
        </Panel>
      ) : null}
      {tab === "audio" ? (
        <SettingsForm
          cat="audio"
          note="Silence below the threshold for the given time switches to the emergency loop. The boundary tolerance decides when a song may overrun the news."
        />
      ) : null}
      {tab === "live" ? (
        <SettingsForm
          cat="live"
          note="How far music ducks under a live mic, and how fast it moves."
        />
      ) : null}
      {tab === "requests" ? <SettingsForm cat="requests" /> : null}
      {tab === "retention" ? (
        <SettingsForm
          cat="retention"
          note="Older history, requests, sessions and recordings are deleted automatically."
        />
      ) : null}
      {tab === "alerts" ? (
        <SettingsForm
          cat="alerts"
          note="Errors and critical alerts are emailed to these addresses. Webhooks are configured in station.json."
        />
      ) : null}
      {tab === "outputs" ? <Outputs manage={manage} /> : null}
      {tab === "triggers" ? <Triggers manage={manage} /> : null}
      {tab === "backups" ? (
        <div className="flex flex-col gap-4">
          <SettingsForm cat="backups" note="How many automatic backups are kept on the server." />
          <Backups manage={manage} />
        </div>
      ) : null}
    </>
  );
}

/** Stereo Tool configuration read-outs (set in station.json on the server). */
const ST_INFO: Record<string, string> = {
  enabled: "Whether audio goes through Stereo Tool. Off = the station plays unprocessed.",
  binary: "Path of the legacy stereotool_cmd program (only used in stdio-pcm mode).",
  preset: "Your Stereo Tool settings file (.sts) with the station's processing sound.",
  edition:
    "Detected at install: 'live' with a licence key, 'free' without. The status below shows the real licence state.",
  inputMode:
    "plugin = Thimeo's libStereoTool library (recommended, like AzuraCast); stdio-pcm = the older command-line program.",
  args: "Command-line arguments for the legacy program (stdio-pcm mode only).",
  wavIo: "Legacy mode only: whether audio is framed as WAV for the command-line program.",
  restart: "How often and how fast Stereo Tool is restarted automatically after a crash.",
  bypassOnFailure:
    "If Stereo Tool keeps failing, play unprocessed audio instead of going silent (and raise an alert).",
  mock: "Test mode with a fake Stereo Tool (development only).",
  licenseKey: "Where the licence key comes from: entered below, from secrets.env, or not set.",
};

const KEY_SOURCE: Record<string, string> = {
  console: "entered here",
  secrets: "from secrets.env",
  none: "not set",
};

/** Stereo Tool licence key: saved on the server (never shown again) and applied at once. */
function LicenseKey({ source, onChanged }: { source: string; onChanged: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      setKey("");
      toast.success(ok);
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-4 flex flex-col gap-2 border-t border-line pt-3">
      <Field
        label="Licence key"
        info="Your Thimeo Stereo Tool registration key. It unlocks the processing features your preset uses; without it Stereo Tool still runs but mixes beeps or a voice into the stream. The key is stored on the server only and never shown again."
        hint={`Current key: ${KEY_SOURCE[source] ?? source}`}
      >
        {(id) => (
          <Input
            id={id}
            type="password"
            autoComplete="off"
            placeholder="Paste your Stereo Tool key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        )}
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          tone="primary"
          busy={busy}
          disabled={key.trim().length < 8}
          onClick={() =>
            run(
              () => put("/api/settings/stereotool/license", { key: key.trim() }),
              "Licence key saved — Stereo Tool restarted",
            )
          }
        >
          Save key
        </Button>
        {source === "console" ? (
          <Button
            busy={busy}
            onClick={() =>
              run(() => del("/api/settings/stereotool/license"), "Licence key removed")
            }
          >
            Remove key
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-faint">
        Saving restarts Stereo Tool (a second of unprocessed audio). Check that the status below
        says <em>licensed</em>; an unlicensed key adds beeps to the stream.
      </p>
    </div>
  );
}

function Outputs({ manage }: { manage: boolean }) {
  const st = useQuery({
    queryKey: ["st"],
    queryFn: () =>
      get<{ config: Record<string, unknown>; status: Record<string, unknown> | null }>(
        "/api/settings/stereotool",
      ),
  });
  const ic = useQuery({
    queryKey: ["ic"],
    queryFn: () =>
      get<{
        config: {
          host: string;
          port: number;
          mounts: { name: string; codec: string; bitrate: string; primary: boolean }[];
          hls: { enabled: boolean };
        };
        encoders: { mount: string; running: boolean; restarts: number }[];
        lastPoll: { ok: boolean; at: string; error?: string } | null;
      }>("/api/settings/icecast"),
  });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Stereo Tool">
        <dl className="grid grid-cols-[140px_1fr] gap-y-1.5 text-sm">
          {Object.entries(st.data?.config ?? {}).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="inline-flex items-center gap-1.5 text-muted">
                {k}
                {ST_INFO[k] ? <InfoTip text={ST_INFO[k]} label={`About ${k}`} /> : null}
              </dt>
              <dd className="truncate">{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
            </div>
          ))}
        </dl>
        {st.data?.status ? (
          <p className="mt-3 text-sm">
            Status:{" "}
            <Badge tone={st.data.status.running ? "good" : "bad"}>
              {st.data.status.bypassed ? "bypassed" : "processing"}
            </Badge>{" "}
            {st.data.status.edition ? (
              <Badge tone={String(st.data.status.edition).includes("unlicensed") ? "warn" : "good"}>
                {String(st.data.status.edition)}
              </Badge>
            ) : null}{" "}
            {st.data.status.error ? (
              <span className="text-clip">{String(st.data.status.error)}</span>
            ) : null}
          </p>
        ) : null}
        {manage && st.data?.config.enabled ? (
          <LicenseKey
            source={String(st.data.config.licenseKey ?? "none")}
            // The status needs a moment after the restart before it reports the licence.
            onChanged={() => {
              void st.refetch();
              setTimeout(() => void st.refetch(), 4000);
            }}
          />
        ) : null}
      </Panel>
      <Panel
        title={
          <span className="inline-flex items-center gap-1.5">
            Icecast mounts
            <InfoTip
              text="The streams listeners connect to (e.g. /hq.mp3), with codec and bitrate. 'up' means the encoder is sending audio to Icecast; 'primary' is the stream the listener page plays first. Mounts are configured in station.json."
              label="About Icecast mounts"
            />
          </span>
        }
      >
        <ul className="flex flex-col gap-1.5 text-sm">
          {ic.data?.config.mounts.map((m) => {
            const enc = ic.data?.encoders.find((e) => e.mount === m.name);
            return (
              <li key={m.name} className="flex items-center gap-2">
                <Badge tone={enc?.running ? "good" : "bad"}>{enc?.running ? "up" : "down"}</Badge>/
                {m.name}{" "}
                <span className="text-faint">
                  {m.codec} {m.bitrate}
                </span>
                {m.primary ? <Badge tone="warn">primary</Badge> : null}
              </li>
            );
          })}
          <li className="text-muted">HLS {ic.data?.config.hls.enabled ? "enabled" : "disabled"}</li>
        </ul>
        <p className="mt-3 text-xs text-faint">
          {ic.data?.config.host}:{ic.data?.config.port} · last stats poll{" "}
          {ic.data?.lastPoll
            ? `${ic.data.lastPoll.ok ? "ok" : ic.data.lastPoll.error} at ${dateTime(ic.data.lastPoll.at)}`
            : "never"}
        </p>
      </Panel>
    </div>
  );
}

interface Trigger {
  id: string;
  label: string;
  action: string;
  mediaId?: number;
  eventId?: number;
}

function Triggers({ manage }: { manage: boolean }) {
  const list = useQuery({
    queryKey: ["triggers"],
    queryFn: () => get<{ items: Trigger[] }>("/api/admin/triggers"),
  });
  const [items, setItems] = useState<Trigger[]>([]);
  useEffect(() => setItems(list.data?.items ?? []), [list.data]);
  const actions = [
    "skip",
    "pause",
    "resume",
    "replay_last",
    "emergency",
    "emergency_clear",
    "play_now",
    "voice_over",
    "live_duck",
    "live_takeover",
    "live_stop",
    "event_start",
  ];
  return (
    <Panel>
      <p className="mb-4 text-sm text-muted">
        Map hardware buttons to actions. A Stream Deck “Website” or HTTP action calls{" "}
        <code className="text-legend">POST /api/triggers/&lt;id&gt;</code> with an API key that has
        the “Fire triggers” scope in the <code className="text-legend">x-api-key</code> header.
      </p>
      <Table>
        <thead>
          <tr>
            {(
              [
                [
                  "ID",
                  "Part of the button's address: POST /api/triggers/<id>. 2–40 lowercase letters, digits or dashes; unique per button.",
                ],
                ["Label", "A name for yourself, e.g. 'Stream Deck – Skip'. Only shown here."],
                [
                  "Action",
                  "What pressing the button does: skip a track, pause/resume, start or clear the emergency loop, play a track now, a voice-over, start/stop live, or start an event.",
                ],
                [
                  "Media / event id",
                  "For play_now and voice_over: the track's number from the Media library. For event_start: the event's number. Other actions ignore it.",
                ],
              ] as const
            ).map(([h, info]) => (
              <th key={h}>
                <span className="inline-flex items-center gap-1.5">
                  {h}
                  <InfoTip text={info} label={`About ${h}`} />
                </span>
              </th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((t, i) => (
            <tr key={i}>
              <td>
                <Input
                  value={t.id}
                  onChange={(e) =>
                    setItems(items.map((x, j) => (j === i ? { ...x, id: e.target.value } : x)))
                  }
                  disabled={!manage}
                  aria-label="Trigger id"
                />
              </td>
              <td>
                <Input
                  value={t.label}
                  onChange={(e) =>
                    setItems(items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
                  }
                  disabled={!manage}
                  aria-label="Label"
                />
              </td>
              <td>
                <Select
                  value={t.action}
                  onChange={(e) =>
                    setItems(items.map((x, j) => (j === i ? { ...x, action: e.target.value } : x)))
                  }
                  disabled={!manage}
                  aria-label="Action"
                >
                  {actions.map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </Select>
              </td>
              <td>
                <Input
                  type="number"
                  value={t.mediaId ?? t.eventId ?? ""}
                  onChange={(e) =>
                    setItems(
                      items.map((x, j) =>
                        j === i
                          ? x.action === "event_start"
                            ? { ...x, eventId: Number(e.target.value) || undefined }
                            : { ...x, mediaId: Number(e.target.value) || undefined }
                          : x,
                      ),
                    )
                  }
                  disabled={!manage}
                  aria-label="Media or event id"
                />
              </td>
              <td>
                <Button
                  size="sm"
                  tone="ghost"
                  onClick={() => setItems(items.filter((_, j) => j !== i))}
                  disabled={!manage}
                >
                  Remove
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {manage ? (
        <div className="mt-4 flex gap-2">
          <Button
            onClick={() =>
              setItems([
                ...items,
                { id: `button-${items.length + 1}`, label: "New button", action: "skip" },
              ])
            }
          >
            Add trigger
          </Button>
          <Button
            tone="primary"
            onClick={async () => {
              try {
                await put("/api/admin/triggers", { items });
                toast.success("Triggers saved");
                void list.refetch();
              } catch (e) {
                toast.error(errorMessage(e));
              }
            }}
          >
            Save triggers
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}

function Backups({ manage }: { manage: boolean }) {
  const list = useQuery({
    queryKey: ["backups"],
    queryFn: () =>
      get<{
        items: {
          id: number;
          path: string;
          type: string;
          size: number;
          created_at: string;
          verified_at: string | null;
        }[];
      }>("/api/admin/backups"),
    enabled: manage,
  });
  const [busy, setBusy] = useState(false);
  return (
    <Panel
      title="Database backups"
      actions={
        manage ? (
          <Button
            tone="primary"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await post("/api/admin/backups");
                toast.success("Backup written and verified");
                void list.refetch();
              } catch (e) {
                toast.error(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Back up now
          </Button>
        ) : null
      }
    >
      <p className="mb-3 text-sm text-muted">
        A verified backup runs every night at 03:15; 14 daily and 8 weekly copies are kept. Restore
        with <code className="text-legend">pnpm db:restore --file …</code> on the server.
      </p>
      <Table>
        <tbody>
          {list.data?.items.map((b) => (
            <tr key={b.id}>
              <td className="text-sm">{dateTime(b.created_at)}</td>
              <td>
                <Badge>{b.type}</Badge>
              </td>
              <td className="truncate text-xs text-faint">{b.path}</td>
              <td className="text-right text-sm">{bytes(b.size)}</td>
              <td>{b.verified_at ? <Badge tone="good">verified</Badge> : null}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Panel>
  );
}
