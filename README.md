# Online Radio Player

A self-hosted online radio station with:

- a **custom Node.js/TypeScript playout engine** (FFmpeg decks + JS mixer),
- a **24 × 1-hour schedule** ported from the `playlist_maker` generator,
- **interactive playout controls** (skip, pause, queue, play-now, voice-over, live takeover),
- **Thimeo Stereo Tool 10** in the audio chain,
- **Icecast** mounts for MP3 HQ, MP3 mobile, Opus, AAC and HLS,
- a React control panel at `/admin` and a public listener page at `/listen`.

> Status: **M0 — foundations and technical spikes.** The workspace is scaffolded; audio spikes are next. See [`PLAN.md`](./PLAN.md) for the full execution plan and [`PROGRESS.md`](./PROGRESS.md) for current status.

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

## Quick start

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Then open:

- API health: <http://127.0.0.1:3001/api/health>
- Web shell: <http://127.0.0.1:5173/>

`pnpm dev` builds the workspace packages and starts the API, playout placeholder, and Vite dev server in parallel.

## Workspace layout

```text
apps/
  api/        Fastify control + public API (scaffold: native HTTP health endpoint)
  playout/    Audio worker (scaffold: heartbeat process)
  web/        React + Vite control panel / public site
packages/
  core/       Domain logic: generator, boundary rules, queue rules
  db/         Drizzle schema, migrations, repositories
  shared/     Zod schemas, shared types, constants
config/       Example station, Icecast, nginx and dev configs
scripts/      Dev, backup, smoke-test, config validation, Stereo Tool mock
docs/         ADRs, API docs, admin guide, runbook
tests/        Unit, integration, e2e (added as milestones progress)
```

## Scripts

| Command | Purpose |
|---|---|
| `pnpm dev` | Build packages and start API + playout + web dev servers |
| `pnpm build` | Build all TypeScript packages and the web app |
| `pnpm typecheck` | Typecheck all packages and the web app |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest |
| `pnpm config:validate` | Validate `config/station.example.json` |
| `pnpm format` | Prettier write |

## Configuration and secrets

- `config/station.example.json` is the documented configuration shape.
- Copy it to `config/station.json` (git-ignored) and edit it.
- Secrets live in `.env` or `/etc/radio/secrets.env`; never commit them.
- Thimeo Stereo Tool is **commercial software**. Do not commit its binary, preset, or license file. The repo only contains paths and integration code.

## Development notes

- The real Thimeo binary is Linux-only. On Windows/macOS use `scripts/mock-stereotool.mjs`, which passes PCM through unchanged.
- Icecast can run via `docker compose -f docker-compose.dev.yml up` (dev config uses port 8000).
- The audio chain is not wired yet; that is M0.4/M0.5.

## Documentation

- [`PLAN.md`](./PLAN.md) — milestones, architecture, data model, risks.
- [`PROGRESS.md`](./PROGRESS.md) — execution checklist.
- [`docs/adr/`](./docs/adr/) — architecture decision records.
- [`docs/api.md`](./docs/api.md) — API notes (grows with M6/M11).
- [`docs/runbook.md`](./docs/runbook.md) — operations.
