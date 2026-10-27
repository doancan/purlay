/**
 * The shared limiter's own decisions (D-201): what it asks Redis, and what it does when Redis does not
 * answer. That the script itself grants one quota across nodes is held against a real Redis
 * (`shared.redis.integration.test.ts`).
 */
import { describe, expect, test } from 'bun:test';
import { fixedClock } from '../platform/clock';
import { aRecordingLogger } from '../testing/doubles';
import { aFakeLink } from '../testing/redis';
import { inProcessRateLimiter } from './rate-limiter';
import { BUCKET_PREFIX, redisRateLimiter } from './redis-limiter';

const BUDGET = { perSecond: 10, burst: 3 };

const limiterOn = (
  link: ReturnType<typeof aFakeLink>,
): { limiter: ReturnType<typeof redisRateLimiter>; lines: Record<string, unknown>[] } => {
  const { log, lines } = aRecordingLogger();
  const limiter = redisRateLimiter({
    link,
    name: 'writes',
    budget: BUDGET,
    local: inProcessRateLimiter(fixedClock(new Date('2026-09-09T12:00:00Z')), BUDGET),
    log,
  });
  return { limiter, lines };
};

describe('the shared limiter', () => {
  test('asks Redis for the named key, with the budget and the cost, and answers what it says', async () => {
    const link = aFakeLink();
    const answers = [1, 0];
    link.behaviour.script = (): unknown => answers.shift();
    const { limiter } = limiterOn(link);
    expect(await limiter.consume('user-1', 2)).toBe(true);
    expect(await limiter.consume('user-1')).toBe(false);
    expect(link.scripts[0]?.keys).toEqual([`${BUCKET_PREFIX}writes:user-1`]);
    expect(link.scripts[0]?.args).toEqual(['10', '3', '2']);
    expect(link.scripts[1]?.args).toEqual(['10', '3', '1']);
  });

  test('two limiters of different names never share a key', async () => {
    const link = aFakeLink();
    link.behaviour.script = (): unknown => 1;
    const { log } = aRecordingLogger();
    const local = inProcessRateLimiter(fixedClock(new Date()), BUDGET);
    await redisRateLimiter({ link, name: 'auth', budget: BUDGET, local, log }).consume('k');
    await redisRateLimiter({ link, name: 'writes', budget: BUDGET, local, log }).consume('k');
    expect(link.scripts.map((s) => s.keys[0])).toEqual([
      `${BUCKET_PREFIX}auth:k`,
      `${BUCKET_PREFIX}writes:k`,
    ]);
  });

  test('with Redis away it falls back to a bucket of its own, which still refuses at its budget', async () => {
    const link = aFakeLink();
    link.state.connected = false;
    const { limiter, lines } = limiterOn(link);
    const answers = [
      await limiter.consume('u'),
      await limiter.consume('u'),
      await limiter.consume('u'),
      await limiter.consume('u'),
    ];
    // Neither failing closed (nobody could write) nor failing open (nobody is limited).
    expect(answers).toEqual([true, true, true, false]);
    expect(lines.every((line) => line['level'] !== 'error')).toBe(true);
  });

  test('an error while connected is said at warn; one while Redis is away only at debug', async () => {
    const link = aFakeLink();
    const { limiter, lines } = limiterOn(link);
    await limiter.consume('u');
    link.state.connected = false;
    await limiter.consume('u');
    expect(lines.map((line) => line['level'])).toEqual(['warn', 'debug']);
  });

  test('an answer that is neither allowed nor refused is not trusted: this node’s own bucket decides', async () => {
    const link = aFakeLink();
    link.behaviour.script = (): unknown => 'surprise';
    const { limiter } = limiterOn(link);
    expect(await limiter.consume('u')).toBe(true);
  });

  test('forgetting a key drops it here and asks Redis to, and a failing Redis is no error', async () => {
    const link = aFakeLink();
    const { limiter } = limiterOn(link);
    limiter.forget('socket-1');
    await Promise.resolve();
    expect(link.sent).toEqual([{ command: 'DEL', args: [`${BUCKET_PREFIX}writes:socket-1`] }]);
  });
});
