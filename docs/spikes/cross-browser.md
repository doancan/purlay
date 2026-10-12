# Spike — the browser suite on Safari's engine and Firefox's (2026-10-13)

The supported browsers are `browserslist` in `apps/web/package.json` — Chrome, Edge, Firefox ≥ 121,
Safari ≥ 17.2, iOS Safari — and D-113 says what lint and the build check of them. The browser suite runs
Chromium alone. A team that moves in on Safari or Firefox would meet anything engine-specific first.
This runs the same suite on WebKit and on Firefox, once, to see what it finds.

## What was run

Playwright 1.64.0, the suite as it is on main (f47849c), against its own demo servers. A configuration
outside the tree (below) gives two projects at 1440 × 900, light: `Desktop Safari` (WebKit 2370)
and `Desktop Firefox` (Firefox 1555). Screenshots are ignored (`--ignore-snapshots`): a baseline is
per engine and per machine, and comparing Chromium's with WebKit's would only measure fonts.

```
bunx playwright test -c .cross.config.ts --ignore-snapshots --reporter=line   # from apps/web
```

## WebKit: 124 of 132 pass; the 8 that fail are the engine's, not the product's

| Tests | Why |
|---|---|
| `frame.e2e.ts:10`, `:21`, `focus.e2e.ts:35`, `navigation.e2e.ts:174`, `:196` — Tab reaches every control | macOS WebKit's Tab moves between form controls only unless the person turns on "Press Tab to highlight each item" (Safari ▸ Settings ▸ Advanced); links are then reached with Option+Tab. The tests' Tab path is Chromium's. |
| `frame.e2e.ts:70` — the theme is set before the first paint | The test reads the `first-paint` performance entry, which WebKit does not report (it reports `first-contentful-paint`). The value read was `undefined`, not the wrong theme. |
| `composer.e2e.ts:404` — offline, a send fails with Retry | WebKit's offline emulation does not cut an open WebSocket, so the message was **delivered** — the row never failed. In Chromium the emulation stops it. |
| `performance.e2e.ts:237` — the heap after a hundred switches | Uses a CDP session, which exists only in Chromium. |

Everything else — sending, threads, reactions, edits and deletes, live updates between two people,
search, the inbox, uploads, invitations, members, the GitHub connection, the audit log, unread markers
and scroll anchoring, the phone width, the error and empty states — passed on WebKit. **No product defect
was found.**

## Firefox, on Linux: 126 of 132 pass; the 6 that fail are the engine's or the harness's

On macOS here Firefox Nightly 1555 would not start (*Could not find profile folder*, with `TMPDIR`,
`HOME` and the browsers path each redirected). So it was run where CI would run it: a Linux container
of the project's own Bun image (`oven/bun:1.4.2`), `bunx playwright install --with-deps firefox`, the
same configuration, against the host's PostgreSQL.

```
docker run --rm -v <copy of the commit>:/repo -w /repo -e DATABASE_URL=postgres://purlay:purlay@host.docker.internal:5432/purlay oven/bun:1.4.2 \
  bash -c "bun install --frozen-lockfile && cd apps/web && bunx playwright install --with-deps firefox && \
           bunx playwright test -c .cross.config.ts --project firefox --ignore-snapshots --reporter=line"
```

| Tests | Why |
|---|---|
| `focus.e2e.ts:35`, `navigation.e2e.ts:196` — Tab walks the page and comes round | Past the last element (the composer's Send), Firefox under Playwright keeps focus on it rather than going round. Measured on a page of two bare buttons: Chromium went *first, last, (out), first*; Firefox *first, last, last, last*. The app's stops before it — Bold, Code block, Mention, Attach, Send — were all reached, ringed, in order. **Not a trap.** |
| `frame.e2e.ts:70` — the theme before the first paint | Firefox reports no `first-paint` entry either. |
| `composer.e2e.ts:145` — a long paste becomes a code block | The test pastes by dispatching `new ClipboardEvent('paste', { clipboardData })`; in Firefox that event's data reads empty (measured: `getData('text/plain')` is `''`), so the handler saw nothing. A real paste carries its data; this is the test's paste, not the product's. |
| `composer.e2e.ts:404` — offline, a send fails with Retry | The offline emulation, as in WebKit. |
| `performance.e2e.ts:237` — the heap | CDP, Chromium only. |

**No product defect was found on Firefox either.** Worth carrying into the suite, if it ever runs a second
engine: the Tab walks should end on leaving the page however the engine shows it, and the paste test needs a
paste the engine honours.

## What had to be loosened

Screenshots were ignored, as above; nothing else. No test or product code changed.

## The configuration (outside the tree)

```ts
import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';
const engines = [
  { name: 'firefox', use: { ...devices['Desktop Firefox'], colorScheme: 'light' as const, viewport: { width: 1440, height: 900 } } },
  { name: 'webkit', use: { ...devices['Desktop Safari'], colorScheme: 'light' as const, viewport: { width: 1440, height: 900 } } },
];
export default defineConfig({
  ...base,
  projects: engines.map((e, i) => ({ ...e, use: { ...e.use, baseURL: `http://localhost:${String(4573 + i * 100)}` } })),
  webServer: engines.map((e, i) => ({
    command: `bun run scripts/demo.ts ${i === 0 ? '' : '--no-build '}--db purlay_e2e_x${String(4573 + i * 100)} --port ${String(4573 + i * 100)} --manifest apps/web/e2e/.world-${e.name}.json`,
    cwd: '../..', env: { VITE_GALLERY: '1' }, url: `http://localhost:${String(4573 + i * 100)}/health`, timeout: 240_000, reuseExistingServer: false, stdout: 'pipe' as const,
  })),
});
```

## Since: one command (2026-10-13)

`PURLAY_E2E_ENGINES=webkit bun run test:e2e -- --project webkit` (or `firefox`) runs the suite on that
engine, light and wide, with screenshots ignored; each limit in the tables above is a `test.skip` that
names it. Run so: **WebKit 124 passed, 8 skipped; Firefox (in the Linux container) 126 passed, 6
skipped — green on both.** Chromium's projects skip nothing.
