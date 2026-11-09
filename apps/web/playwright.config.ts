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
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

type Project = NonNullable<PlaywrightTestConfig['projects']>[number];

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

/**
 * One project alone: `PURLAY_E2E_PROJECT=chromium-dark bun run test:e2e`. The pipeline runs the four
 * as four jobs, so each has a machine to itself — the suite fits its time, and a latency measured
 * there is the page's, not three other browsers' and servers' sharing two cores. Only that project's
 * server starts. The name of an engine (`webkit`) runs that engine's project alone, below. A name that is
 * neither refuses to run, rather than running all four.
 */
const only = process.env['PURLAY_E2E_PROJECT'] ?? '';
const ENGINES = { webkit: 'Desktop Safari', firefox: 'Desktop Firefox' } as const;
const isEngine = (name: string): name is keyof typeof ENGINES => name in ENGINES;
if (only !== '' && !isEngine(only) && !projects.some((definition) => definition.name === only)) {
  throw new Error(
    `PURLAY_E2E_PROJECT names ${only}; it takes ${[...projects.map((definition) => definition.name), ...Object.keys(ENGINES)].join(', ')}`,
  );
}
const chosen = projects.filter((definition) => only === '' || definition.name === only);

/**
 * The files that write a measurement `budget:browser` judges, run apart from the rest (D-227):
 * `PURLAY_E2E_PERFORMANCE=skip` runs every other file, `only` runs these alone — the pipeline runs them
 * after the suite, on one worker, so no other test competes for the machine while they measure. Unset,
 * everything runs, as it always has. A value that is neither refuses to run.
 */
const MEASURING = ['**/performance.e2e.ts', '**/feed-scale.e2e.ts'];
const PERFORMANCE_MODES = ['', 'skip', 'only'];
const performanceMode = process.env['PURLAY_E2E_PERFORMANCE'] ?? '';
if (!PERFORMANCE_MODES.includes(performanceMode)) {
  throw new Error(
    `PURLAY_E2E_PERFORMANCE is ${performanceMode}; it takes skip or only, or nothing`,
  );
}

/**
 * The server with no module (D-250), apart from the rest: `PURLAY_E2E_MODULES=none bun run test:modules-none`
 * serves the same seeded world with `MODULES=none` and runs `modules-none.e2e.ts` alone; every other run
 * leaves that file out, so the suite's servers and time are what they were. A value other than `none` refuses to run.
 */
const MODULES_NONE = '**/modules-none.e2e.ts';
const e2eModules = process.env['PURLAY_E2E_MODULES'] ?? '';
if (e2eModules !== '' && e2eModules !== 'none') {
  throw new Error(`PURLAY_E2E_MODULES is ${e2eModules}; it takes none, or nothing`);
}
const coreOnly = e2eModules === 'none';
// The first port of the run; each project takes the next. Overridable so two checkouts (or a
// person's own `bun run demo`) each have their harness.
// With no module it has its own ports by default: a server of the full suite left running (`reuseExistingServer`) must never answer for it.
const BASE_PORT = Number(process.env['PURLAY_E2E_PORT'] ?? (coreOnly ? 4673 : 4173));

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

/**
 * Engines beyond Chromium: `PURLAY_E2E_ENGINES=webkit,firefox bun run test:e2e` adds them to a run, and
 * `PURLAY_E2E_PROJECT=webkit` runs one alone, which is how CI runs WebKit (a job of its own beside the
 * Chromium four; Firefox is opt in only). Light, wide, and with no screenshots — a baseline is one
 * engine's. What an engine cannot do as the suite asks is skipped in the test, by engine and with why
 * (`docs/spikes/cross-browser.md`). A name that is not one of these refuses to run, rather than
 * running Chromium alone and looking like it ran the rest.
 */
const engines = [
  ...(process.env['PURLAY_E2E_ENGINES'] ?? '').split(',').map((name) => name.trim()),
  ...(isEngine(only) ? [only] : []),
]
  .filter((name, at, names) => name !== '' && names.indexOf(name) === at)
  .map((name) => {
    if (!isEngine(name)) {
      throw new Error(
        `PURLAY_E2E_ENGINES names ${name}; it takes ${Object.keys(ENGINES).join(', ')}`,
      );
    }
    return name;
  });
const servers = [...chosen.map((definition) => definition.name), ...engines];

/**
 * WebKit is served over https, with a certificate made for the run. The session cookie is `Secure` and
 * `__Host-`, and WebKit on Linux does not send one to `http://localhost` (macOS WebKit, Chromium and
 * Firefox do): signed in by that cookie, every page came up signed out. The tests trust the certificate
 * through `ignoreHTTPSErrors` for this origin only.
 */
const overTls = (name: string): boolean => name === 'webkit';
const schemeOf = (name: string): string => (overTls(name) ? 'https' : 'http');
/**
 * The certificate WebKit's origin is served with, made once for the machine and trusted by name: the
 * test process's own requests (`support.ts` makes rooms through the real API) reach that origin too, and
 * Node is told to trust this one certificate (`NODE_EXTRA_CA_CERTS`, read by the workers as they start),
 * never to skip validation. The main process makes it before any worker exists; a worker finds it there.
 */
const TLS_DIR = join(tmpdir(), 'purlay-e2e-tls');
const TLS_CERT = join(TLS_DIR, 'localhost.crt');
const TLS_KEY = join(TLS_DIR, 'localhost.key');
// Made into the temporary directory, which the machine clears; long enough that it never expires under a run.
const TLS_VALID_DAYS = 3650;
if (servers.some(overTls)) {
  if (!existsSync(TLS_CERT) || !existsSync(TLS_KEY)) {
    mkdirSync(TLS_DIR, { recursive: true });
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', String(TLS_VALID_DAYS)]
        .concat(['-keyout', TLS_KEY, '-out', TLS_CERT, '-subj', '/CN=localhost'])
        .concat(['-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']),
      { stdio: 'ignore' },
    );
  }
  process.env['NODE_EXTRA_CA_CERTS'] = TLS_CERT;
}

const engineProject = (engine: keyof typeof ENGINES, index: number): Project => ({
  name: engine,
  ignoreSnapshots: true,
  use: {
    ...devices[ENGINES[engine]],
    colorScheme: 'light',
    viewport: { width: 1440, height: 900 },
    baseURL: `${schemeOf(engine)}://localhost:${String(portOf(index))}`,
    ignoreHTTPSErrors: overTls(engine),
  },
});

export default defineConfig({
  testDir: './e2e',
  // Not `.spec.ts`: `bun test` discovers that name and would try to run Playwright's tests.
  testMatch: coreOnly ? MODULES_NONE : performanceMode === 'only' ? MEASURING : '**/*.e2e.ts',
  testIgnore: [
    ...(coreOnly ? [] : [MODULES_NONE]),
    ...(performanceMode === 'skip' ? MEASURING : []),
  ],
  // One folder per project, so a light screenshot is never compared with a dark one.
  // The platform is in the path: `system-ui` is a different face on every operating system, so a
  // baseline photographed on one is not a baseline for another. Each platform keeps its own, and
  // the first run on a new one writes them (`bun run test:e2e:update`).
  snapshotPathTemplate:
    '{testDir}/__snapshots__/{platform}/{projectName}/{testFileName}-snapshots/{arg}{ext}',
  fullyParallel: true,
  forbidOnly: ci,
  // Never: a test that passes the second time is a flaky test the first failure would have shown (`CONTRIBUTING.md` §5).
  retries: 0,
  reporter: ci ? [['github'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  use: {
    // A failure keeps its trace, since there is no second run to take one on.
    trace: 'retain-on-failure',
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
  projects: [
    ...chosen.map(project),
    ...engines.map((engine, index) => engineProject(engine, chosen.length + index)),
  ],
  // Servers start one after the other: the first builds the client, the rest serve that build.
  webServer: servers.map((name, index) => ({
    command: `bun --no-env-file --env-file=.env.test run scripts/demo.ts ${index === 0 ? '' : '--no-build '}${coreOnly ? '--modules none ' : ''}${overTls(name) ? `--tls-cert ${TLS_CERT} --tls-key ${TLS_KEY} ` : ''}--db purlay_e2e_${String(portOf(index))} --port ${String(portOf(index))} --manifest apps/web/e2e/.world-${name}.json`,
    cwd: '../..',
    env: { VITE_GALLERY: '1' },
    url: `${schemeOf(name)}://localhost:${String(portOf(index))}/health`,
    ignoreHTTPSErrors: overTls(name),
    // Building, migrating and seeding two hundred messages through the real API.
    timeout: 240_000,
    reuseExistingServer: !ci,
    stdout: 'pipe' as const,
  })),
});
