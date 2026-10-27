/**
 * What closes O-4 (#61): for each connection, the most frames it sent in any one second and how
 * many the budget refused — said when it closes, so a week of the log answers whether ten a second
 * with a burst of sixty is the right number for real typing and pasting.
 */
import { describe, expect, test } from 'bun:test';
import { metered } from './frame-meter';
import { inProcessRateLimiter } from './rate-limiter';

const at = (ms: number): { now: () => Date } => ({ now: () => new Date(ms) });

describe('a metered frame budget', () => {
  test('counts frames, the busiest second, and what was refused, per connection', async () => {
    let now = 0;
    const clock = { now: (): Date => new Date(now) };
    const limiter = metered(inProcessRateLimiter(clock, { perSecond: 1, burst: 3 }), clock);
    for (const ms of [0, 100, 200, 300, 1_000, 1_900, 2_500]) {
      now = ms;
      await limiter.consume('a');
    }
    now = 2_600;
    await limiter.consume('b');
    // Second 0: four frames, the fourth past a burst of three; second 1: two, the second before a
    // token has come back; second 2: one.
    expect(limiter.report('a')).toEqual({ frames: 7, peakPerSecond: 4, refused: 2 });
    expect(limiter.report('b')).toEqual({ frames: 1, peakPerSecond: 1, refused: 0 });
  });

  test('forgets a closed connection, and knows nothing of one it never saw', async () => {
    const clock = at(0);
    const limiter = metered(inProcessRateLimiter(clock, { perSecond: 10, burst: 20 }), clock);
    await limiter.consume('a');
    limiter.forget('a');
    expect(limiter.report('a')).toEqual({ frames: 0, peakPerSecond: 0, refused: 0 });
    expect(limiter.held()).toBe(0);
  });
});
