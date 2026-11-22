# Online Radio Player

A self-hosted online radio station with:

- a **custom Node.js/TypeScript playout engine** (FFmpeg decks + JS mixer),
- a **24 × 1-hour schedule** ported from the `playlist_maker` generator,
- **interactive playout controls** (skip, pause, queue, play-now, voice-over, live takeover),
- **Thimeo Stereo Tool 10** in the audio chain,
- **Icecast** mounts for MP3 HQ, MP3 mobile, Opus, AAC and HLS,
- a React control panel at `/admin` and a public listener page at `/listen`.

> Status: **feature-complete (M1–M15).** Ready for installation on the production LXC; the items
> that need the real host (licensed Stereo Tool flags, 24 h soak, TLS) are in
> [`docs/launch-checklist.md`](./docs/launch-checklist.md). Details in [`PROGRESS.md`](./PROGRESS.md).

## Architecture at a glance

```text
Media library ──► FFmpeg decks ──► JS mixer ──► Thimeo Stereo Tool
                                                   │
                                                   ▼
                                      FFmpeg encoders ──► Icecast
                                                   │
                                     ┌─────────────┼─────────────┐
                                     ▼             ▼             ▼
                                  MP3 HQ       MP3 mobile    Opus/AAC/HLS
                                     │
                                     ▼
                              /listen + public API
```

The API and playout engine are separate processes:

- `apps/api` — Fastify API, auth, database writer, WebSocket, public API.
- `apps/playout` — audio worker: decks, mixer, scheduler, Stereo Tool link, encoders.

## Requirements

- Node.js **22+** (developed on Node 26)
- pnpm **10+**
- FFmpeg **6+** on `PATH` (needed for audio spikes and playout)
- Linux for production (Debian 13 LXC); Windows is supported for UI/API development with a passthrough Stereo Tool mock.

## Install on a server

```bash
sudo ./scripts/install.sh --domain radio.example.com --email ops@example.com
```

See [`docs/install.md`](./docs/install.md) (Debian 13 LXC, Stereo Tool, staging, upgrade, uninstall).

## Development quick start

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Then open:

- API health: <http://127.0.0.1:3001/api/health>
- Web shell: <http://127.0.0.1:5173/>

`pnpm dev` builds the workspace packages and starts the API, the playout worker (tone source,
mock Stereo Tool) and the Vite dev server in parallel. `pnpm demo` runs a self-contained stack with
generated fixtures and seeded users (`admin` / `demo-password-123`).

## Workspace layout

```text
apps/
  api/        Fastify control + public API, auth/RBAC, WebSocket, media ingestion, jobs
  playout/    Audio worker: decks, mixer, scheduler, Stereo Tool adapter, encoders, live uplink
  web/        React + Vite broadcast console (/admin) and listener site (/listen)
packages/
  core/       Domain logic: generator, boundary rules, queue rules
  db/         Drizzle schema, migrations, repositories
  shared/     Zod schemas, shared types, constants
config/       Example station, Icecast, nginx and dev configs
deploy/       systemd units, nginx template, Grafana dashboard + Prometheus scrape config
scripts/      install/upgrade/uninstall, backup/restore, smoke test, CLI, benchmarks, Stereo Tool mock
docs/         Install, admin guide, API, runbook, security review, launch checklist, ADRs
tests/        Integration (real Icecast) and Playwright E2E; unit tests sit next to the code
```

## Scripts

| Command                                                    | Purpose                                                  |
| ---------------------------------------------------------- | -------------------------------------------------------- |
| `pnpm dev`                                                 | Build packages and start API + playout + web dev servers |
| `pnpm build`                                               | Build all TypeScript packages and the web app            |
| `pnpm typecheck`                                           | Typecheck all packages and the web app                   |
| `pnpm lint`                                                | ESLint                                                   |
| `pnpm test`                                                | Unit + API tests (`test:coverage` enforces thresholds)   |
| `pnpm test:integration`                                    | Audio chain against a real Icecast (Linux)               |
| `pnpm test:e2e`                                            | Playwright flows against the demo stack                  |
| `pnpm config:validate`                                     | Validate a station config (default: the example)         |
| `pnpm db:migrate` / `db:seed` / `db:backup` / `db:restore` | Database lifecycle                                       |
| `pnpm media:scan`                                          | Scan the library (`--analyze` for loudness)              |
| `pnpm icecast:config`                                      | Generate the Icecast config from the station config      |
| `pnpm load:test`                                           | Listener/WebSocket/API load test                         |
| `pnpm format`                                              | Prettier write                                           |

## Configuration and secrets

- `config/station.example.json` is the documented configuration shape.
- Copy it to `config/station.json` (git-ignored) and edit it.
- Secrets live in `.env` or `/etc/radio/secrets.env`; never commit them.
- Thimeo Stereo Tool is **commercial software**. Do not commit its binary, preset, or license file. The repo only contains paths and integration code.

## Development notes

- The real Thimeo binary is Linux-only. On Windows/macOS use `scripts/mock-stereotool.mjs`, which passes PCM through unchanged.
- Icecast can run via `docker compose -f docker-compose.dev.yml up` (dev config uses port 8000).

## Documentation

- [`PLAN.md`](./PLAN.md) — milestones, architecture, data model, risks.
- [`PROGRESS.md`](./PROGRESS.md) — execution checklist.
- [`docs/install.md`](./docs/install.md) — install, LXC notes, staging, upgrade, uninstall.
- [`docs/admin-guide.md`](./docs/admin-guide.md) — running the station from the console.
- [`docs/runbook.md`](./docs/runbook.md) — operations, alerts, backup/restore, budgets.
- [`docs/api.md`](./docs/api.md) — API conventions and every endpoint (OpenAPI at `/api/docs`).
- [`docs/security-review.md`](./docs/security-review.md) — M15.1 review and accepted exceptions.
- [`docs/launch-checklist.md`](./docs/launch-checklist.md) — go-live sign-off.
- [`docs/adr/`](./docs/adr/) — architecture decision records.
- [`NOTICE`](./NOTICE) — third-party components and licensing.
