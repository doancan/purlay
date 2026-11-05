import { describe, expect, test } from 'bun:test';
import { AppError } from '../platform/errors';
import { createLogger, type Logger } from '../platform/logging';
import { createReplayGate } from './replay-gate';

/** A turn the test holds until it says so. */
const aHold = (): { released: Promise<void>; release: () => void } => {
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { released, release };
};

const TURN_WAIT_MS = 1_000;
const silent = createLogger({ level: 'silent' });

describe('the replay gate', () => {
  test('runs at most the limit at once, and gives the rest their turns in the order they asked', async () => {
    const gate = createReplayGate(2, silent, TURN_WAIT_MS);
    const holds = [aHold(), aHold(), aHold(), aHold()];
    const started: number[] = [];
    let running = 0;
    let mostAtOnce = 0;
    const runs = holds.map(
      async (hold, index) =>
        await gate(async () => {
          started.push(index);
          running += 1;
          mostAtOnce = Math.max(mostAtOnce, running);
          await hold.released;
          running -= 1;
          return index;
        }),
    );
    await Bun.sleep(5);
    expect(started).toEqual([0, 1]);

    holds[1]?.release();
    await Bun.sleep(5);
    expect(started).toEqual([0, 1, 2]);
    holds[0]?.release();
    await Bun.sleep(5);
    expect(started).toEqual([0, 1, 2, 3]);
    holds[2]?.release();
    holds[3]?.release();

    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3]);
    expect(mostAtOnce).toBe(2);
  });

  test('returns what the work returns, and runs a lone replay at once', async () => {
    const gate = createReplayGate(1, silent, TURN_WAIT_MS);
    expect(await gate(async () => await Promise.resolve('frames'))).toBe('frames');
  });

  test('gives the turn back when the work fails, and passes the failure on', async () => {
    const gate = createReplayGate(1, silent, TURN_WAIT_MS);
    const failure = new Error('read failed');
    const caught: unknown = await gate(async () => await Promise.reject(failure)).catch(
      (error: unknown) => error,
    );
    expect(caught).toBe(failure);
    // With a leaked turn this would wait out the deadline and be refused.
    expect(await gate(async () => await Promise.resolve('next'))).toBe('next');
  });

  test('refuses a wait past its deadline as an overloaded server, and takes no turn afterwards', async () => {
    const refusals: string[] = [];
    const log: Logger = {
      ...silent,
      info: (message) => {
        refusals.push(message);
      },
    };
    const gate = createReplayGate(1, log, 20);
    const hold = aHold();
    const first = gate(async () => {
      await hold.released;
      return 'first';
    });

    const error: unknown = await gate(async () => await Promise.resolve('never')).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ body: { code: 'DATABASE_UNAVAILABLE' } });
    expect(refusals).toEqual(['replay refused: too many sockets replaying at once']);

    // The one that gave up is no longer in line: the turn freed now is the next caller's, not its.
    hold.release();
    expect(await first).toBe('first');
    expect(await gate(async () => await Promise.resolve('after'))).toBe('after');
    expect(refusals).toEqual(['replay refused: too many sockets replaying at once']);
  });
});
