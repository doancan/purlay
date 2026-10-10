/**
 * The browser tests: the built client, a real API, a real database, real Chromium.
 *
 * What the component tests cannot say — layout, focus, a keyboard path, a theme that
 * flashes, a number that is a time — is asserted here, against the production shape (D-61):
 * `scripts/demo.ts` builds the client (the gallery included, `VITE_GALLERY=1`), recreates
 * a scratch database named `purlay_e2e`, seeds the demo workspace through the real API,
 * and serves it all on one origin. A test signs in by carrying the genuine session cookie
 * the seed issued (`e2e/fixtures.ts`).
 *
 * **Every screen is photographed in every theme and at two widths** — the four projects
 * below — because a screen that only works in one theme is the failure D-53 names, and a
 * narrow window is a thing `UX.md` §2 promises not to break.
 */
import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

type Project = NonNullable<PlaywrightTestConfig['projects']>[number];

const PORT = 4173;
const ci = process.env['CI'] !== undefined;

const desktop = { width: 1440, height: 900 } as const;
const narrow = { width: 820, height: 900 } as const;

const project = (
  name: string,
  colorScheme: 'dark' | 'light',
  viewport: { width: number; height: number },
): Project => ({
  name,
  use: { ...devices['Desktop Chrome'], colorScheme, viewport },
});

export default defineConfig({
  testDir: './e2e',
  // Not `.spec.ts`: `bun test` discovers that name and would try to run Playwright's tests.
  testMatch: '**/*.e2e.ts',
  // One folder per project, so a light screenshot is never compared with a dark one.
  snapshotPathTemplate: '{testDir}/__snapshots__/{projectName}/{testFileName}-snapshots/{arg}{ext}',
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  reporter: ci ? [['github'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${String(PORT)}`,
    trace: 'on-first-retry',
    // The only motion in the product is a 120 ms collapse (`UX.md` §9); a screenshot
    // must never catch it half done.
    reducedMotion: 'reduce',
    // What a test reads must not depend on the machine it ran on.
    locale: 'en-US',
    timezoneId: 'UTC',
  },
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: 'disabled' },
  },
  projects: [
    project('chromium-dark', 'dark', desktop),
    project('chromium-light', 'light', desktop),
    project('chromium-dark-narrow', 'dark', narrow),
    project('chromium-light-narrow', 'light', narrow),
  ],
  webServer: {
    command: `bun run scripts/demo.ts --db purlay_e2e --port ${String(PORT)} --manifest apps/web/e2e/.world.json`,
    cwd: '../..',
    env: { VITE_GALLERY: '1' },
    url: `http://localhost:${String(PORT)}/health`,
    // Building, migrating and seeding two hundred messages through the real API.
    timeout: 240_000,
    reuseExistingServer: !ci,
    stdout: 'pipe',
  },
});
