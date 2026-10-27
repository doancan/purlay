/**
 * The three node-local things a second node would make wrong, in their shared form (D-201, D-7, D-25):
 * the bus, the limiters and presence. Built only from a connected `RedisLink`, which exists only when
 * `REDIS_URL` is set; without one nothing here is called and the in-process implementations run exactly as
 * before — a self-hosted instance never meets this file (`shared.test.ts` holds that).
 */
import type { Clock } from '../platform/clock';
import type { Logger } from '../platform/logging';
import type { RedisLink } from '../platform/redis';
import type { Backplane } from './bus';
import type { PresenceDirectory } from './online';
import { inMemoryPresenceRegistry, type PresenceRegistry } from './presence';
import { inProcessLimiters, type LimiterFactory } from './rate-limiter';
import { redisBackplane } from './redis-bus';
import { redisRateLimiter } from './redis-limiter';
import { redisPresenceDirectory, redisPresenceRegistry } from './redis-presence';

/** What the application is given beside the bus when nodes share state. Absent: everything is in process. */
export interface SharedState {
  readonly limiters: LimiterFactory;
  readonly typing: PresenceRegistry;
  readonly directory: PresenceDirectory;
  /** A reason this node should not take traffic yet: it has never reached the shared state. */
  readonly problem: () => string | undefined;
}

export interface SharedRealtime {
  readonly backplane: Backplane;
  readonly shared: SharedState;
}

export const sharedRealtime = (link: RedisLink, clock: Clock, log: Logger): SharedRealtime => ({
  backplane: redisBackplane(link, log),
  shared: {
    // A bucket of this node's own answers while Redis does not (D-201).
    limiters: (name, budget) =>
      redisRateLimiter({
        link,
        name,
        budget,
        local: inProcessLimiters(clock)(name, budget),
        log,
      }),
    typing: redisPresenceRegistry(link, log, inMemoryPresenceRegistry(clock)),
    directory: redisPresenceDirectory(link, crypto.randomUUID()),
    problem: link.problem,
  },
});
