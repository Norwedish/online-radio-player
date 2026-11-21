# Tests

Test suites are added as milestones land:

- `unit/` — pure domain tests (Vitest), also colocated as `*.test.ts` next to source.
- `integration/` — real FFmpeg/Icecast/worker tests (M4/M5).
- `e2e/` — Playwright browser flows (M9–M14).

Run the current unit tests with:

```bash
pnpm test
```
