/**
 * The modules the server's administrator has stopped at run time (D-296), as every part of a node asks it: a set read from the
 * table `suspended_modules` through a cache that is at most `SUSPENSION_TTL_MS` old, so the hot path pays no query of its own and
 * a change made on any node reaches every other within the TTL, without a restart and without anything but the database to carry it.
 *
 * Failing static: a read that fails keeps the set last read and says so once, because a database blip must not lift a stop that
 * an operator put on for an incident. A node that has never read it holds the empty set, which is also what a node of a release
 * that predates the table does; the write that stops a module waits for the cluster for that reason (`modules/suspension`).
 */
import type { Executor } from '@purlay/db';
import type { Logger } from './logging';

/**
 * How stale a node's view of the stops may be: the contract of the kill switch (an operator sees it take effect on every node
 * within this). Short enough to be an incident tool and long enough that a node reads the table twice a second at most.
 */
export const SUSPENSION_TTL_MS = 2_000;

export interface Suspension {
  /** The set as last read, with no wait: for the places that cannot await (a socket's frame, a route table). */
  readonly current: () => ReadonlySet<string>;
  /** The set, read again when the last read is older than the TTL; at most one read at a time, however many ask. */
  readonly fresh: () => Promise<ReadonlySet<string>>;
  /** What a node that has just committed a change knows at once, and an older read still in flight must not overwrite. */
  readonly replace: (modules: ReadonlySet<string>) => void;
  /** Keeps `current` within the TTL on a node that nothing asks `fresh` of (a socket-only or idle one). */
  readonly start: () => void;
  readonly stop: () => void;
}

const NONE: ReadonlySet<string> = new Set();

/** No module is ever stopped: what a composition without a database (a test of one module's pieces) is given. */
export const noSuspension: Suspension = {
  current: () => NONE,
  fresh: () => Promise.resolve(NONE),
  replace: () => undefined,
  start: () => undefined,
  stop: () => undefined,
};

export const readSuspended = async (executor: Executor): Promise<ReadonlySet<string>> =>
  new Set(
    (await executor.selectFrom('suspended_modules').select('module').execute()).map(
      ({ module }) => module,
    ),
  );

export const suspensionCache = ({
  read,
  log,
  now = (): number => performance.now(),
  ttlMs = SUSPENSION_TTL_MS,
}: {
  readonly read: () => Promise<ReadonlySet<string>>;
  readonly log: Logger;
  /** Milliseconds on a clock that only goes forward; a test drives it. */
  readonly now?: () => number;
  readonly ttlMs?: number;
}): Suspension => {
  let held: ReadonlySet<string> = NONE;
  let readAt = Number.NEGATIVE_INFINITY;
  let generation = 0;
  let inFlight: Promise<ReadonlySet<string>> | undefined;
  let failing = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const reread = async (): Promise<ReadonlySet<string>> => {
    const started = generation;
    try {
      const modules = await read();
      // A change committed here while this read was out is newer than the read.
      if (started === generation) held = modules;
      if (failing) log.info('the stopped modules can be read again');
      failing = false;
    } catch (error) {
      if (!failing) {
        log.warn('the stopped modules could not be read; keeping the set last read', {
          err: error,
        });
      }
      failing = true;
    }
    readAt = now();
    return held;
  };

  const fresh = async (): Promise<ReadonlySet<string>> => {
    if (now() - readAt < ttlMs) return held;
    inFlight ??= reread().finally(() => {
      inFlight = undefined;
    });
    return await inFlight;
  };

  return {
    current: () => held,
    fresh,
    replace: (modules): void => {
      generation += 1;
      held = modules;
      readAt = now();
    },
    start: (): void => {
      if (timer !== undefined) return;
      void fresh();
      timer = setInterval(() => void fresh(), ttlMs / 2);
      timer.unref();
    },
    stop: (): void => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
};
