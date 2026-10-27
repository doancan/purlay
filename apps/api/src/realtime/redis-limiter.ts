/**
 * The rate limiter several nodes share (D-201, D-25): one bucket per key in Redis, so N nodes grant one
 * quota and not N.
 *
 * **One atomic script.** A token bucket read, refilled, spent and written back in two round trips would let
 * two nodes both read the same tokens and both spend them; the script does it in one step inside Redis, on
 * Redis's own clock (`TIME`), so nodes whose clocks differ still agree. The numbers are the in-process
 * bucket's, line for line (`rate-limiter.ts`): it starts full, refills continuously, spends `cost`. The key
 * expires once it would have refilled, which is the same as no bucket, so nothing is swept.
 *
 * **A Redis that does not answer costs the quota's sharing, never the service (D-201).** The caller is then
 * charged to a bucket of this node's own: on N nodes that is N times the quota for as long as Redis is away,
 * which is what an in-process limiter always was. Failing closed would turn a Redis outage into every write
 * refused; failing open with no bucket at all would turn it into no limit. The limiter "never throws" (its
 * interface), and this keeps that true.
 */
import type { Logger } from '../platform/logging';
import type { RedisLink } from '../platform/redis';
import type { RateBudget, RateLimiter } from './rate-limiter';

const BUCKET_SCRIPT = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local held = redis.call('HMGET', KEYS[1], 'tokens', 'at')
local tokens = tonumber(held[1])
local at = tonumber(held[2])
if tokens == nil or at == nil then
  tokens = burst
  at = now
end
tokens = math.min(burst, tokens + math.max(0, now - at) / 1000 * rate)
local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'at', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(burst / rate * 1000) + 1000)
return allowed
`;

export const BUCKET_PREFIX = 'purlay:rl:';

export interface RedisLimiterOptions {
  readonly link: RedisLink;
  readonly name: string;
  readonly budget: RateBudget;
  /** What answers while Redis does not: a bucket of this node's own. */
  readonly local: RateLimiter;
  readonly log: Logger;
}

export const redisRateLimiter = ({
  link,
  name,
  budget,
  local,
  log,
}: RedisLimiterOptions): RateLimiter => {
  const keyOf = (key: string): string => `${BUCKET_PREFIX}${name}:${key}`;
  return {
    consume: async (key, cost = 1): Promise<boolean> => {
      try {
        const answer = await link.script(
          BUCKET_SCRIPT,
          [keyOf(key)],
          [String(budget.perSecond), String(budget.burst), String(cost)],
        );
        if (answer === 1) return true;
        if (answer === 0) return false;
        throw new Error('the bucket script answered something else');
      } catch (error) {
        // An error while connected is news; while Redis is away the connection has said so already.
        (link.connected() ? log.warn : log.debug)(
          'the shared limiter could not answer; using this node’s own bucket',
          { limiter: name, err: error },
        );
        return await local.consume(key, cost);
      }
    },
    forget: (key): void => {
      local.forget(key);
      // Best effort: the key expires by itself once it would have refilled, so a miss costs nothing.
      link.send('DEL', [keyOf(key)]).catch(() => undefined);
    },
  };
};
