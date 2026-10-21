/**
 * A DOM, for component tests only.
 *
 * `happy-dom` alone does not give one: rendering fails with
 * `ReferenceError: document is not defined` until its global registrator has
 * run. The stack table named only the first half (`docs/spikes/web-client.md`).
 *
 * A component test calls `installDom()` once, at the top of its file, rather than
 * relying on a `bunfig.toml` preload, which would install a DOM into **every**
 * test in the repository — including the API and database suites, which have no
 * business having one.
 *
 * **A function, not an import with a side effect.** This used to register its
 * hooks when the module was imported, and a module is imported once per process:
 * the first component test file got a DOM and the second got
 * `document is not defined`. It stayed hidden while one component test existed.
 * The second one (the icons, #137) found it. Hooks belong to the file that asks.
 *
 * One consequence worth knowing: Radix is imported *before* this DOM exists, and
 * decides at import time that there is none. `radix-preload.ts` is what makes it
 * work anyway.
 */
import { afterAll, afterEach, beforeAll } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { cleanup } from '@testing-library/react';
import { createRequire } from 'node:module';

interface Scheduler {
  readonly unstable_scheduleCallback: (priority: number, callback: () => void) => unknown;
  readonly unstable_NormalPriority: number;
  readonly unstable_IdlePriority: number;
}

/**
 * The scheduler `react-dom` itself runs on — resolved from `react-dom`, so it is the same module
 * instance and the same queue, not a second copy with nothing in it.
 */
export const reactScheduler = (): Scheduler => {
  const fromHere = createRequire(import.meta.url);
  return createRequire(fromHere.resolve('react-dom'))('scheduler') as Scheduler;
};

/**
 * Resolves once everything React has queued has run. The scheduler runs its queue in priority
 * order, so a task at idle priority runs only when nothing else is waiting: a positive condition,
 * not a guess at how long the queue takes (`CONTRIBUTING.md` §6.3).
 */
export const settleScheduler = async (): Promise<void> => {
  const scheduler = reactScheduler();
  await new Promise<void>((resolve) => {
    scheduler.unstable_scheduleCallback(scheduler.unstable_IdlePriority, resolve);
  });
};

/**
 * Registered **in a lifecycle hook**, not when called.
 *
 * `bun test` imports every file it selects, including ones whose tests are all
 * filtered out — so a top-level `register()` fires even when nothing in this file
 * runs, and the matching `afterAll` never does. That is how a component test file
 * broke six API tests in another package during `test:integration`, a run in
 * which it executed nothing at all.
 */
export const installDom = (): void => {
  beforeAll(() => {
    // An origin, as the deployed client has: `about:blank` resolves no relative URL, so an
    // `<img src="/api/…">` would fail the moment it was drawn.
    GlobalRegistrator.register({ url: 'https://purlay.test/' });
  });

  /**
   * What a test rendered is removed when the test ends. Testing Library does this
   * itself when the runner has a global `afterEach`; this runner's is not seen
   * from there, so without it every test's render piles up in the one `document`
   * and a query finds the previous test's button too.
   */
  afterEach(() => {
    cleanup();
  });

  /**
   * And undone when the file is finished.
   *
   * Registering replaces globals — `Request`, `Response` and `Headers` among them —
   * for the whole process, because `bun test` runs every file in one. A "per-file"
   * DOM that is never unregistered is not per-file; it is global with a later start
   * time.
   *
   * Found by running the whole suite rather than the file under test. Each file
   * passed alone. A green run of one file is not a green run.
   */
  afterAll(async () => {
    // An unmount leaves effects for React to run later; they read `window`, so they run first.
    await settleScheduler();
    await GlobalRegistrator.unregister();
  });
};

/**
 * **The global `screen` does not work with this, and lint refuses it.**
 *
 * `@testing-library/dom` decides at *its own module evaluation* whether a global
 * document exists, and binds `screen` to `document.body` or to a set of throwing
 * stubs accordingly. That happens before this module runs, despite the import
 * order in the file — measured, not reasoned about:
 *
 * ```
 * [probe] document.body = <body></body>
 * [probe] screen.getByRole is function
 * [probe] render queries work: hi
 * [probe] screen threw: For queries bound to document.body a global document has to…
 * ```
 *
 * A `bunfig.toml` preload would fix it, at the price of installing a DOM into
 * **every** test in the repository — including the API and database suites,
 * where a dependency that feature-detects `window` would quietly take its
 * browser path. A silent behaviour change in server code, caused by a test
 * harness, is a worse trade than an unavailable convenience.
 *
 * So component tests use the queries `render` returns. They are scoped to what
 * the test rendered rather than to the whole document, which is the better habit
 * anyway, and `within(element)` covers the rest.
 */
