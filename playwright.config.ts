import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

/**
 * E2E (PLAN M10.7 / M14.3): runs against the self-contained demo stack
 * (fixtures + Icecast + playout worker + API serving the built UI).
 * Build the UI first: `pnpm --filter @radio/web build && pnpm test:e2e`.
 * Uses the system Chrome when Playwright's own browser is not installed.
 */
const port = Number(process.env.E2E_PORT ?? 3399);
const systemChrome = [
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((p) => existsSync(p));

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: process.env.CI ? "retain-on-failure" : "off",
    ...devices["Desktop Chrome"],
    launchOptions: {
      ...(process.env.PW_CHROMIUM ? {} : systemChrome ? { executablePath: systemChrome } : {}),
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
    permissions: ["microphone"],
  },
  webServer: {
    command: `tsx scripts/demo-stack.ts`,
    url: `http://127.0.0.1:${port}/api/ready`,
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
    env: {
      DEMO_FRESH_DB: "1",
      DEMO_PORT: String(port),
      DEMO_TRACKS: "30",
      DEMO_DIR: process.env.E2E_DATA_DIR ?? "/tmp/radio-e2e",
    },
    stdout: "ignore",
    stderr: "pipe",
  },
});
