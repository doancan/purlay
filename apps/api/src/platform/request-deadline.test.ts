import { describe, expect, test } from 'bun:test';
import { AppError } from './errors';
import { DEFAULT_DEADLINE_MS, deadlinesOf, timedOut, withDeadline } from './request-deadline';

describe('the deadline of each module', () => {
  const manifests = [
    { id: 'plain' },
    { id: 'quick', deadline: { ms: 8_000 } },
    { id: 'long', deadline: { none: 'it streams a download the client reads at its own pace' } },
  ] as const;

  test('is what the manifest says, the default for a module that says nothing, and none for one that declared it has none', () => {
    const deadlineOf = deadlinesOf(manifests);
    expect([deadlineOf('plain'), deadlineOf('quick'), deadlineOf('long')]).toEqual([
      DEFAULT_DEADLINE_MS,
      8_000,
      undefined,
    ]);
    expect(deadlineOf('nobody')).toBeUndefined();
  });
});

describe('a request against its deadline', () => {
  test('answers what the work answered, and does not abort, when it finishes in time', async () => {
    let seen: AbortSignal | undefined;
    const answer = await withDeadline(
      1_000,
      (signal) => {
        seen = signal;
        return Promise.resolve('done');
      },
      () => 'expired',
    );
    expect(answer).toBe('done');
    expect(seen?.aborted).toBe(false);
  });

  test('answers REQUEST_TIMEOUT at the deadline, aborts the signal with it, and does not wait for the work', async () => {
    let seen: AbortSignal | undefined;
    const started = performance.now();
    const answer = await withDeadline(
      30,
      (signal) => {
        seen = signal;
        // Never returns: the deadline is what ends the wait.
        return new Promise<string>(() => undefined);
      },
      () => 'expired',
    );
    expect(answer).toBe('expired');
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBeInstanceOf(AppError);
    expect((seen?.reason as AppError).body.code).toBe('REQUEST_TIMEOUT');
  });

  test('lets a failure of the work through, and stops the clock', async () => {
    const failure = new Error('the work failed');
    const caught = await withDeadline(
      20,
      () => Promise.reject(failure),
      () => 'expired',
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(caught).toBe(failure);
    // The timer is gone: nothing is left to fire after the work ended.
    await Bun.sleep(40);
  });

  test('is not troubled by work that fails after it was given up on', async () => {
    const answer = await withDeadline(
      10,
      () =>
        new Promise<string>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error('cancelled underneath'));
          }, 40);
        }),
      () => 'expired',
    );
    expect(answer).toBe('expired');
    // The rejection arrives with nobody waiting: it is not an unhandled one, or this run would die of it.
    await Bun.sleep(80);
  });

  test('tells a request that overran what happened, and that it may have been done', () => {
    expect(timedOut().body.code).toBe('REQUEST_TIMEOUT');
    expect(timedOut().body.message).toContain('Check what it asked for');
  });
});
