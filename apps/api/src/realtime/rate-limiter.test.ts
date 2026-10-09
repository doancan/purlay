/**
 * The bucket, against a clock this test moves.
 *
 * The socket test proves a running server refuses; this proves the arithmetic —
 * the burst, the refill, and that one key spending its budget costs no other key
 * anything.
 */
import { describe, expect, test } from 'bun:test';
import type { Clock } from '../platform/clock';
import { inProcessRateLimiter, SOCKET_FRAME_BUDGET } from './rate-limiter';

const movable = (): Clock & { advance: (ms: number) => void } => {
  let now = new Date('2026-09-09T12:00:00.000Z').getTime();
  return {
    now: (): Date => new Date(now),
    advance: (ms: number): void => {
      now += ms;
    },
  };
};

const spend = async (
  limiter: ReturnType<typeof inProcessRateLimiter>,
  key: string,
  times: number,
): Promise<boolean[]> => {
  const answers: boolean[] = [];
  for (let i = 0; i < times; i += 1) answers.push(await limiter.consume(key));
  return answers;
};

describe('the in-process rate limiter', () => {
  test('a quiet connection may send its whole burst at once, and no more', async () => {
    const limiter = inProcessRateLimiter(movable(), SOCKET_FRAME_BUDGET);
    const answers = await spend(limiter, 'a', SOCKET_FRAME_BUDGET.burst + 1);
    expect(answers.slice(0, SOCKET_FRAME_BUDGET.burst).every(Boolean)).toBe(true);
    expect(answers.at(-1)).toBe(false);
  });

  test('it refills at the sustained rate, never past the burst', async () => {
    const clock = movable();
    const limiter = inProcessRateLimiter(clock, SOCKET_FRAME_BUDGET);
    await spend(limiter, 'a', SOCKET_FRAME_BUDGET.burst);
    expect(await limiter.consume('a')).toBe(false);

    clock.advance(1000);
    const afterOneSecond = await spend(limiter, 'a', SOCKET_FRAME_BUDGET.perSecond + 1);
    expect(afterOneSecond.filter(Boolean)).toHaveLength(SOCKET_FRAME_BUDGET.perSecond);

    clock.advance(60_000);
    const afterAMinute = await spend(limiter, 'a', SOCKET_FRAME_BUDGET.burst + 1);
    expect(afterAMinute.filter(Boolean)).toHaveLength(SOCKET_FRAME_BUDGET.burst);
  });

  test('one key spending its budget costs another key nothing', async () => {
    const limiter = inProcessRateLimiter(movable(), SOCKET_FRAME_BUDGET);
    await spend(limiter, 'noisy', SOCKET_FRAME_BUDGET.burst + 5);
    expect(await limiter.consume('quiet')).toBe(true);
  });

  test('a forgotten key starts again full', async () => {
    const limiter = inProcessRateLimiter(movable(), SOCKET_FRAME_BUDGET);
    await spend(limiter, 'a', SOCKET_FRAME_BUDGET.burst);
    expect(await limiter.consume('a')).toBe(false);
    limiter.forget('a');
    expect(await limiter.consume('a')).toBe(true);
  });

  /** A key per client address grows with every address that ever knocked. */
  test('keys that have refilled are dropped once too many are held, and live ones are kept', async () => {
    const clock = movable();
    const limiter = inProcessRateLimiter(clock, SOCKET_FRAME_BUDGET, 100);
    await limiter.consume('busy', SOCKET_FRAME_BUDGET.burst);
    for (let i = 0; i < 150; i += 1) await limiter.consume(`once-${String(i)}`);
    expect(limiter.held()).toBe(151);

    clock.advance(5000);
    await limiter.consume('next');
    // The one-frame keys have long since refilled; 'busy' emptied its bucket 5 s
    // ago at 10 a second and is full again too, so only the key just used remains.
    expect(limiter.held()).toBeLessThan(10);

    // A key still owed time is never dropped: it would be a free refill.
    await limiter.consume('drained', SOCKET_FRAME_BUDGET.burst);
    for (let i = 0; i < 150; i += 1) await limiter.consume(`more-${String(i)}`);
    clock.advance(1000);
    await limiter.consume('trigger');
    expect(await limiter.consume('drained', SOCKET_FRAME_BUDGET.burst)).toBe(false);
  });

  test('forgetting a key releases its bucket, so a reconnect leaves nothing behind', async () => {
    const limiter = inProcessRateLimiter(movable(), SOCKET_FRAME_BUDGET);
    await spend(limiter, 'a', 1);
    await spend(limiter, 'b', 1);
    expect(limiter.held()).toBe(2);
    limiter.forget('a');
    expect(limiter.held()).toBe(1);
    limiter.forget('b');
    limiter.forget('never-seen');
    expect(limiter.held()).toBe(0);
  });
});
