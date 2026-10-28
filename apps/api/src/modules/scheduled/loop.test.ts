import { expect, test } from 'bun:test';
import { aRecordingLogger } from '../../testing/doubles';
import { timedDeliveryLoop } from './loop';

test('timed delivery never overlaps, retries failures and drains before shutdown', async () => {
  let finish: (() => void) | undefined;
  let next: (() => void) | undefined;
  let cancelled = false;
  let calls = 0;
  const { log, lines } = aRecordingLogger();
  const loop = timedDeliveryLoop(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporarily unavailable');
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    (callback, milliseconds) => {
      expect(milliseconds).toBe(15_000);
      next = callback;
      return (): void => {
        cancelled = true;
      };
    },
    log,
  );
  loop.start();
  loop.start();
  await Promise.resolve();
  await Promise.resolve();
  expect(calls).toBe(1);
  expect(lines).toHaveLength(1);
  next?.();
  let stopped = false;
  const stopping = loop.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  expect(cancelled).toBe(true);
  finish?.();
  await stopping;
  expect(stopped).toBe(true);
  expect(calls).toBe(2);
});
