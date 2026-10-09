// Playwright smoke and accessibility tests (phase9-spec.md §4).
//
//   npm run test:e2e                      all specs, light and dark
//   npm run test:e2e -- e2e/editor.spec.ts --project=light
//   npm run test:e2e:ui                   the interactive runner
//   npx playwright show-report            the last HTML report
//
// The web server is `next dev` on PLAYWRIGHT_PORT (default 3107) with the dev
// auth bypass and both e2e stubs on (src/lib/e2e/mode.ts): no Clerk sign-in,
// no model or Blob traffic, and no Postgres (the in-memory stores). The real
// keys in .env are overridden with fakes (@next/env never replaces a variable
// that is already set), so a call that misses a stub fails instead of spending.
// It builds into .next-e2e (gitignored) so it can run beside a normal `npm run
// dev`. The first compile of each route is slow; timeouts allow for it.
//
// Browser: the installed Google Chrome when there is one, else Playwright's
// own Chromium (`npx playwright install chromium` once).

import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PLAYWRIGHT_PORT || 3107);
const BASE_URL = `http://localhost:${PORT}`;
const chrome = existsSync("/Applications/Google Chrome.app") ? { channel: "chrome" } : {};

/** Specs that click through flows run once, in light; the axe scan runs in both schemes. */
const FUNCTIONAL = /(editor|modal|upload|export|keyboard|redesign)\.spec\.ts$/;

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.spec.ts",
  // One dev server and one in-memory store: specs run one at a time so a
  // first compile or a background model stub never races another spec.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    ...devices["Desktop Chrome"],
    ...chrome,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    navigationTimeout: 90_000,
    actionTimeout: 20_000,
  },
  projects: [
    { name: "light", use: { colorScheme: "light" } },
    { name: "dark", use: { colorScheme: "dark" }, testIgnore: FUNCTIONAL },
  ],
  webServer: {
    command: `npx next dev --turbopack -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      SASHA_NEXT_DIST_DIR: ".next-e2e",
      SASHA_DEV_AUTH_BYPASS: "1",
      SASHA_E2E_STUB_MODELS: "1",
      SASHA_E2E_STUB_BLOB: "1",
      // Fakes in place of .env's real values (see the header).
      BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_e2estore_notarealsecret",
      BLOB_STORE_ID: "e2estore",
      BLOB_ACCESS: "public",
      ANTHROPIC_API_KEY: "e2e-stub-not-a-key",
      ANTHROPIC_AUTH_TOKEN: "",
      GEMINI_API_KEY: "e2e-stub-not-a-key",
      // Empty is unset to the app (every store checks `!!process.env.POSTGRES_URL`).
      POSTGRES_URL: "",
      NEXT_TELEMETRY_DISABLED: "1",
      // No rate limits: a reused server keeps the in-memory counters across
      // runs, and every run is the same bypass user, so re-running a spec within
      // the hour hit e.g. learn's 4/h. (A server started before this was added
      // keeps its old env: stop it once.) LIMIT_FAMILIES in src/lib/limits/contract.ts.
      ...Object.fromEntries(
        ["light", "check", "draft", "ingest", "workflow", "learn", "export"].flatMap((family) =>
          ["USER", "TEAM"].map((side) => [`SASHA_LIMIT_${family.toUpperCase()}_${side}`, "off"]),
        ),
      ),
    },
  },
});
