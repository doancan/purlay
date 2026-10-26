/**
 * Callbacks that carry one state are answered one at a time (`oneAtATime`), so the second of two that
 * arrive together is told its try is over and not that GitHub is unavailable (D-121 §3).
 */
import { describe, expect, test } from 'bun:test';
import { oneAtATime } from './auth';

const gate = (): { promise: Promise<void>; open: () => void } => {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

describe('callbacks with one state', () => {
  test('are answered one at a time, in the order they came', async () => {
    const events: string[] = [];
    const first = gate();
    const a = oneAtATime('s', async () => {
      events.push('a starts');
      await first.promise;
      events.push('a ends');
      return 'a';
    });
    const b = oneAtATime('s', () => {
      events.push('b starts');
      return Promise.resolve('b');
    });
    await Promise.resolve();
    expect(events).toEqual(['a starts']);
    first.open();
    expect(await Promise.all([a, b])).toEqual(['a', 'b']);
    expect(events).toEqual(['a starts', 'a ends', 'b starts']);
  });

  test('do not wait for another state, or for none', async () => {
    const held = gate();
    const slow = oneAtATime('one', () => held.promise.then(() => 'one'));
    expect(await oneAtATime('two', () => Promise.resolve('two'))).toBe('two');
    expect(await oneAtATime(null, () => Promise.resolve('none'))).toBe('none');
    expect(await oneAtATime('', () => Promise.resolve('empty'))).toBe('empty');
    held.open();
    expect(await slow).toBe('one');
  });

  test('a first that fails does not stop the second, and its failure is its own', async () => {
    const failing = oneAtATime('s', () => Promise.reject(new Error('first failed')));
    const next = oneAtATime('s', () => Promise.resolve('second'));
    const failure = await failing.then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('first failed');
    expect(await next).toBe('second');
  });

  test('leave nothing behind: the same state can be used again, at once', async () => {
    await oneAtATime('again', () => Promise.resolve(1));
    const started: string[] = [];
    await oneAtATime('again', () => {
      started.push('ran');
      return Promise.resolve(2);
    });
    expect(started).toEqual(['ran']);
  });
});
