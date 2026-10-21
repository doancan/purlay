/**
 * The DOM is taken away only after React's scheduler has run what it holds (`dom.ts`).
 *
 * Found in CI, once in three runs: a file's last test unmounted a tree whose effects React
 * scheduled for later, the file's `afterAll` removed `window`, and the scheduled work then read
 * `window.event` — `ReferenceError: window is not defined`, between tests, failing the run with
 * every test green. Here the same work is queued on purpose, so the order is not left to timing.
 */
import { expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { reactScheduler, settleScheduler } from './dom';

const queueWorkThatReadsWindow = (): { readonly ran: () => string } => {
  let seen = 'not run';
  reactScheduler().unstable_scheduleCallback(reactScheduler().unstable_NormalPriority, () => {
    seen = typeof window;
  });
  return { ran: () => seen };
};

test('work React has queued runs before the DOM is taken away', async () => {
  GlobalRegistrator.register({ url: 'https://purlay.test/' });
  const work = queueWorkThatReadsWindow();
  expect(work.ran()).toBe('not run');
  await settleScheduler();
  expect(work.ran()).toBe('object');
  await GlobalRegistrator.unregister();
});

test('without settling, the same work would meet no window — which is what this guards', async () => {
  GlobalRegistrator.register({ url: 'https://purlay.test/' });
  const work = queueWorkThatReadsWindow();
  await GlobalRegistrator.unregister();
  await settleScheduler();
  expect(work.ran()).toBe('undefined');
});
