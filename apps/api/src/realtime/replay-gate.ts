/**
 * How many sockets of this node may be replaying at the same moment.
 *
 * A replay holds up to 1,000 frames or 1 MiB while it is read and built, about 0.4 MB measured, so a
 * mass reconnect of 2,000 sockets held 1.2 GB at once where the same work done in turn holds a fraction
 * (#1029). The rest wait their turn in the order they asked, and a client sees only a later `ACK`. A wait
 * that outlasts its deadline is answered as an overloaded server always is: `DATABASE_UNAVAILABLE`, which
 * the client resends after a growing wait (`ARCHITECTURE.md` §5.4).
 */
import { AppError } from '../platform/errors';
import type { Logger } from '../platform/logging';
import { slots } from '../platform/module-budget';

/**
 * Under the 25 s of silence after which a client sends a `PING` (§5.4), which would wait behind the replay
 * in the connection's queue: a wait must end with an answer before the client starts doubting the socket.
 * Long enough that a storm is served in the order it arrived and not refused and sent again (measured,
 * `DEPLOY.md`), since a refusal costs the client a wait and the node the authorisation again.
 */
const REPLAY_WAIT_MS = 15_000;

/** Runs `work` once a turn is free, and gives the turn back however `work` ends. */
export type ReplayGate = <T>(work: () => Promise<T>) => Promise<T>;

export const createReplayGate = (
  limit: number,
  log: Logger,
  waitMs: number = REPLAY_WAIT_MS,
): ReplayGate => {
  const turns = slots(limit);
  return async (work) => {
    if (!(await turns.acquire(waitMs))) {
      // Counted, because it is what tells an operator the limit is below what a storm needs.
      log.info('replay refused: too many sockets replaying at once', { limit });
      throw new AppError({
        code: 'DATABASE_UNAVAILABLE',
        message: 'The service is busy. Try again shortly.',
      });
    }
    try {
      return await work();
    } finally {
      turns.release();
    }
  };
};
