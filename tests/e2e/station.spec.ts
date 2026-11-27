/**
 * Critical flows end to end (PLAN §9.3): login + RBAC, playout control,
 * schedule override persistence, media tag edit, listener request →
 * moderation, events, live studio with a fake microphone, public player.
 */
import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "demo-password-123";

async function login(page: Page, username: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/admin");
}

test.describe.configure({ mode: "serial" });

test("unauthenticated admin redirects to login, wrong password is refused", async ({ page }) => {
  await page.goto("/admin/studio");
  await expect(page).toHaveURL(/\/login\?next=%2Fadmin%2Fstudio/);
  await page.getByLabel("Username or email").fill("admin");
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("invalid username or password");
});

test("roles: DJ sees no Users/Settings, admin does", async ({ page }) => {
  await login(page, "dj");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Studio" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Users" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Settings" })).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out" }).click();
  await login(page, "admin");
  await expect(
    page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Users" }),
  ).toBeVisible();
});

test("studio automation: skip changes the track, pause/resume and the queue survive a refresh", async ({
  page,
}) => {
  await login(page, "operator");
  // The old console URL redirects to the studio.
  await page.goto("/admin/playout");
  await expect(page).toHaveURL(/\/admin\/studio$/);
  const automation = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Automation", exact: true }) });
  const title = automation.locator("p.font-display").first();
  await expect(title).not.toHaveText("");
  const before = await title.textContent();
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(title).not.toHaveText(before ?? "", { timeout: 10_000 });
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByText("paused", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("paused", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByText("paused", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/locked/).first()).toBeVisible();
});

test("studio players: playing A takes over from automation, hand back resumes it", async ({
  page,
}) => {
  await login(page, "operator");
  await page.goto("/admin/studio");
  const a = page.getByRole("region", { name: "Player A" });
  // "Load" opens the library drawer at the bottom of the screen with the search focused.
  await a.getByRole("button", { name: "Load", exact: true }).click();
  const library = page.getByRole("region", { name: "Library" });
  await expect(library.getByLabel("Search the library")).toBeFocused();
  await library.getByLabel("Search the library").fill("Coastline");
  await library
    .getByRole("button", { name: /into player A$/ })
    .first()
    .click();
  await expect(a.getByText("Cued", { exact: true })).toBeVisible();
  // Drag-and-drop from the drawer onto player B.
  const b = page.getByRole("region", { name: "Player B" });
  await library.getByRole("listitem").first().dragTo(b);
  await expect(b.getByText("Cued", { exact: true })).toBeVisible();
  // …and onto pre-listen.
  const prelisten = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Pre-listen" }) });
  await library.getByRole("listitem").first().dragTo(prelisten);
  await expect(prelisten).toContainText("Coastline");
  // Closed, only the tab button remains (the drawer would cover the decks on this screen).
  await library.getByRole("button", { name: "Close the library" }).click();
  await expect(library).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Library", exact: true })).toBeVisible();
  await a.getByRole("button", { name: "Play player A" }).click();
  await expect(page.getByText("MANUAL", { exact: true })).toBeVisible();
  await expect(a.getByText("On air", { exact: true })).toBeVisible();
  // The remaining-time counter runs.
  const remaining = a.getByLabel("Player A remaining");
  const first = await remaining.textContent();
  await expect(remaining).not.toHaveText(first ?? "", { timeout: 5_000 });
  await page.getByRole("button", { name: "Hand back to automation" }).click();
  await expect(page.getByText("AUTOMATION", { exact: true })).toBeVisible();
  await expect(a.getByText("Cued", { exact: true })).toBeVisible({ timeout: 10_000 });
  // The tab opens the drawer again.
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.getByRole("region", { name: "Library" })).toBeVisible();
});

test("schedule: editing hour 14 persists after reload", async ({ page }) => {
  await login(page, "operator");
  await page.goto("/admin/schedule");
  const row = page.locator("tr", { hasText: "14:00" });
  await row.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Public programme name").fill("Afternoon Drive");
  await page.getByRole("button", { name: "Save hour" }).click();
  await expect(page.getByText("Saved 14:00")).toBeVisible();
  await page.reload();
  await expect(page.locator("tr", { hasText: "14:00" })).toContainText("Afternoon Drive");
  await page.goto("/listen/schedule");
  await expect(page.getByText("Afternoon Drive")).toBeVisible();
});

test("media: search and edit tags", async ({ page }) => {
  await login(page, "operator");
  await page.goto("/admin/media");
  await page.getByLabel("Search media").fill("Evergreen");
  await page.getByLabel("Search media").fill("Signal");
  const firstRow = page.locator("tbody tr").first();
  await firstRow.click();
  const album = page.getByLabel("Album");
  await album.fill("E2E Edition");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.reload();
  await page.getByLabel("Search media").fill("E2E Edition");
  await expect(page.locator("tbody tr")).toHaveCount(1);
});

test("listener request → moderation → approved", async ({ page, browser }) => {
  const listener = await browser.newPage();
  await listener.goto("/listen");
  await listener.getByLabel("Search the library").fill("Coastline");
  await listener.getByRole("listitem").getByRole("button").first().click();
  await listener.getByLabel("Dedication").fill("for the E2E team");
  await listener.getByRole("button", { name: "Send request" }).click();
  await expect(listener.getByText("Waiting for the studio")).toBeVisible();
  await login(page, "dj");
  await page.goto("/admin/requests");
  const req = page.locator("li", { hasText: "for the E2E team" });
  await expect(req).toBeVisible();
  await req.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Approved for the next hour")).toBeVisible();
  await listener.reload();
  await expect(listener.getByText("Approved, coming up")).toBeVisible({ timeout: 35_000 });
  await listener.close();
});

test("events: create and start a stinger event", async ({ page }) => {
  await login(page, "operator");
  await page.goto("/admin/events");
  await page.getByRole("button", { name: "New event" }).click();
  await page.getByLabel("Title").fill("E2E sting");
  await page.getByLabel("Type").selectOption("stinger");
  await page.getByLabel("Playlist").selectOption({ label: "Jingles" });
  await page.getByRole("button", { name: "Schedule event" }).click();
  const row = page.locator("tr", { hasText: "E2E sting" });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Start now" }).click();
  await expect(row).toContainText("active");
});

test("live studio: fake mic goes live, ducks, and ends", async ({ page }) => {
  await login(page, "dj");
  await page.goto("/admin/studio");
  await page.getByRole("button", { name: "Enable microphone" }).click();
  await page.getByRole("button", { name: "Go live" }).click();
  await expect(page.getByText(/On air \d/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Live mic", { exact: true }).first()).toBeVisible();
  // The browser uplink really reaches the worker and audio flows.
  await expect(page.getByText(/Uplink connected · sent (0\.[1-9]|[1-9])/)).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "End live" }).click();
  await expect(page.getByRole("button", { name: "Go live" })).toBeVisible({ timeout: 15_000 });
});

test("public listen page plays the stream", async ({ page }) => {
  await page.goto("/listen");
  await page.getByRole("button", { name: "Play live" }).click();
  await expect
    .poll(async () => page.evaluate(() => document.querySelector("audio")?.currentTime ?? 0), {
      timeout: 20_000,
    })
    .toBeGreaterThan(0.5);
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
});
