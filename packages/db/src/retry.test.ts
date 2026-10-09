import { describe, expect, test } from 'bun:test';
import pg from 'pg';
import { isDeadlock, retryOnDeadlock, type Retry } from './retry';

const databaseError = (code: string, message: string): pg.DatabaseError => {
  const error = new pg.DatabaseError(message, 0, 'error');
  error.code = code;
  return error;
};
const deadlock = (): pg.DatabaseError => databaseError('40P01', 'deadlock detected');

const FAST = { attempts: 4, pausesMilliseconds: [1, 2, 3] } as const;

describe('retrying a migration that was the victim of a deadlock', () => {
  test('only SQLSTATE 40P01 is a deadlock', () => {
    expect(isDeadlock(deadlock())).toBe(true);
    expect(isDeadlock(databaseError('23503', 'foreign key violation'))).toBe(false);
    expect(isDeadlock(databaseError('57014', 'canceling statement due to statement timeout'))).toBe(
      false,
    );
    expect(isDeadlock(new Error('deadlock detected'))).toBe(false);
    expect(isDeadlock(undefined)).toBe(false);
  });

  test('runs again after a deadlock, reporting each retry with the wait that follows it', async () => {
    const retries: Retry[] = [];
    let calls = 0;
    const result = await retryOnDeadlock(
      () => {
        calls += 1;
        return calls < 3 ? Promise.reject(deadlock()) : Promise.resolve('applied');
      },
      FAST,
      (retry) => retries.push(retry),
    );
    expect(result).toBe('applied');
    expect(calls).toBe(3);
    expect(retries.map((r) => [r.attempt, r.pauseMilliseconds, r.error.message])).toEqual([
      [1, 1, 'deadlock detected'],
      [2, 2, 'deadlock detected'],
    ]);
  });

  test('is bounded: the last deadlock is thrown as it was after the attempts run out', async () => {
    const retries: Retry[] = [];
    let calls = 0;
    const outcome = await retryOnDeadlock(
      () => {
        calls += 1;
        return Promise.reject(deadlock());
      },
      FAST,
      (retry) => retries.push(retry),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isDeadlock(outcome)).toBe(true);
    expect(calls).toBe(FAST.attempts);
    expect(retries.map((r) => r.pauseMilliseconds)).toEqual([1, 2, 3]);
  });

  test('the last pause repeats when there are more retries than pauses', async () => {
    const retries: Retry[] = [];
    await retryOnDeadlock(
      () => Promise.reject(deadlock()),
      { attempts: 4, pausesMilliseconds: [1] },
      (retry) => retries.push(retry),
    ).catch(() => undefined);
    expect(retries.map((r) => r.pauseMilliseconds)).toEqual([1, 1, 1]);
  });

  test('anything else is thrown at once and never retried', async () => {
    let calls = 0;
    const retries: Retry[] = [];
    const outcome = await retryOnDeadlock(
      () => {
        calls += 1;
        return Promise.reject(databaseError('23503', 'foreign key violation'));
      },
      FAST,
      (retry) => retries.push(retry),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(pg.DatabaseError);
    expect(calls).toBe(1);
    expect(retries).toEqual([]);
  });
});
