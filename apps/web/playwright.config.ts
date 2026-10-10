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

// The first port of the run; each project takes the next. Overridable so two checkouts (or a
// person's own `bun run demo`) each have their harness.
const BASE_PORT = Number(process.env['PURLAY_E2E_PORT'] ?? 4173);
const ci = process.env['CI'] !== undefined;

/**
 * **One world per project: its own server, its own port, its own database, its own people.**
 * The four projects used to share one: the write budget is per person (`RATE_LIMITED`, 10 a second
 * from each), so one project's history writers starved another project's page of the budget it sends
 * with, and one project's reading changed the unread counts another asserted on. Isolating by room
 * and persona inside one world cannot remove the first (the people are the same four) and only
 * hides the second; separate worlds remove both by construction, and cost one more process and one
 * more scratch database each — seconds, once, against flakes forever. Within a project the specs
 * still make a room of their own (`support.ts`), because they run in parallel.
 */
const projects = [
  { name: 'chromium-dark', colorScheme: 'dark', viewport: { width: 1440, height: 900 } },
  { name: 'chromium-light', colorScheme: 'light', viewport: { width: 1440, height: 900 } },
  { name: 'chromium-dark-narrow', colorScheme: 'dark', viewport: { width: 820, height: 900 } },
  { name: 'chromium-light-narrow', colorScheme: 'light', viewport: { width: 820, height: 900 } },
] as const;

// A harness uses its port for the web origin and the next one for the API: a hundred apart keeps clear of whatever else is listening nearby.
const portOf = (index: number): number => BASE_PORT + index * 100;

const project = (definition: (typeof projects)[number], index: number): Project => ({
  name: definition.name,
  use: {
    ...devices['Desktop Chrome'],
    colorScheme: definition.colorScheme,
    viewport: definition.viewport,
    baseURL: `http://localhost:${String(portOf(index))}`,
  },
});

export default defineConfig({
  testDir: './e2e',
  // Not `.spec.ts`: `bun test` discovers that name and would try to run Playwright's tests.
  testMatch: '**/*.e2e.ts',
  // One folder per project, so a light screenshot is never compared with a dark one.
  // The platform is in the path: `system-ui` is a different face on every operating system, so a
  // baseline photographed on one is not a baseline for another. Each platform keeps its own, and
  // the first run on a new one writes them (`bun run test:e2e:update`).
  snapshotPathTemplate:
    '{testDir}/__snapshots__/{platform}/{projectName}/{testFileName}-snapshots/{arg}{ext}',
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  reporter: ci ? [['github'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  use: {
    trace: 'on-first-retry',
    // The only motion in the product is a 120 ms collapse (`UX.md` §9); a screenshot
    // must never catch it half done.
    reducedMotion: 'reduce',
    // What a test reads must not depend on the machine it ran on.
    locale: 'en-US',
    timezoneId: 'UTC',
  },
  expect: {
    // A flow crosses a socket, a server transaction and a cache; on a busy machine five seconds is
    // a guess, ten is a verdict. (Latency *claims* are measured in the page, not by this timeout.)
    timeout: 10_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: 'disabled' },
  },
  projects: projects.map(project),
  // Servers start one after the other: the first builds the client, the rest serve that build.
  webServer: projects.map((definition, index) => ({
    command: `bun run scripts/demo.ts ${index === 0 ? '' : '--no-build '}--db purlay_e2e_${String(portOf(index))} --port ${String(portOf(index))} --manifest apps/web/e2e/.world-${definition.name}.json`,
    cwd: '../..',
    env: { VITE_GALLERY: '1' },
    url: `http://localhost:${String(portOf(index))}/health`,
    // Building, migrating and seeding two hundred messages through the real API.
    timeout: 240_000,
    reuseExistingServer: !ci,
    stdout: 'pipe' as const,
  })),
});
