/**
 * How the process ends: drained, not dropped (#220).
 *
 * A deploy or a restart sends SIGTERM. Ended where it stands, the process cuts
 * the requests in flight, drops every socket with an abnormal close its client
 * has to interpret, and keeps reporting *ready* until it is gone. Drained, a
 * restart is a reconnect nobody notices: readiness says no at once, every socket
 * is told `RESTARTING` and replays from its cursor, in-flight requests finish,
 * the pool closes, and the process exits.
 *
 * Here rather than in `index.ts` so it can be tested without a process: the
 * signals, the exit and the timer are arguments.
 */
import type { Logger } from './platform/logging';
import type { RuntimeHolder } from './modules/setup/runtime';
import { systemTimers, type Timers } from './realtime/hub';

export interface ProcessLike {
  readonly on: (signal: 'SIGTERM' | 'SIGINT', handler: () => void) => void;
  readonly exit: (code: number) => void;
}

export interface Shutdown {
  /** The application's half: stop taking work, let in-flight work finish. */
  readonly drain: () => Promise<void>;
  /** Then what it held open. */
  readonly closeDatabase: () => Promise<void>;
  readonly log: Logger;
  readonly process: ProcessLike;
  /**
   * How long a drain may take before the process exits anyway, saying so. A
   * request that never finishes must not keep a restart from happening.
   */
  readonly deadlineMs: number;
  readonly timers?: Timers;
  /** Whether an error escaped every handler meanwhile: then a drain that finishes still exits 1. */
  readonly crashed?: () => boolean;
}

/**
 * Wires SIGTERM and SIGINT to a drained exit. Returns the shutdown itself, so a
 * test can start one without sending a signal. A second signal does not start a
 * second shutdown.
 */
export const installShutdown = ({
  drain,
  closeDatabase,
  log,
  process,
  deadlineMs,
  timers = systemTimers,
  crashed = (): boolean => false,
}: Shutdown): ((signal: string) => Promise<void>) => {
  let started = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (started) return;
    started = true;
    log.info('shutting down', { signal, deadlineMs });

    const deadline = timers.set(() => {
      log.error('shutdown passed its deadline; exiting with work still open', { deadlineMs });
      process.exit(1);
    }, deadlineMs);

    try {
      await drain();
      log.info('drained: no new work, in-flight requests finished, sockets told to reconnect');
      await closeDatabase();
      log.info('database pool closed');
      timers.clear(deadline);
      process.exit(crashed() ? 1 : 0);
    } catch (error) {
      timers.clear(deadline);
      log.error('shutdown failed', { err: error });
      process.exit(1);
    }
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }
  return shutdown;
};

export interface CrashProcess {
  readonly on: (
    event: 'unhandledRejection' | 'uncaughtException',
    handler: (reason: unknown) => void,
  ) => void;
  readonly exit: (code: number) => void;
}

export interface Crash {
  /** The log line. Not the tracked logger: the report goes through `report`, which may jump the queue. */
  readonly log: Logger;
  /** Sends the report to the error tracker as urgent, past a tracker full of ordinary reports. */
  readonly report: (message: string, fields: Record<string, unknown>) => void;
  /** Sends what the tracker holds, so the report of this crash leaves before the process does. */
  readonly flush: () => Promise<void>;
  readonly process: CrashProcess;
  /** How long the flush may take: a collector that does not answer must not keep a broken process up. */
  readonly deadlineMs: number;
  readonly timers?: Timers;
}

export interface CrashHandle {
  /** Whether an error escaped every handler: a shutdown that ends after one ends with 1, not 0. */
  readonly crashed: () => boolean;
  /**
   * What stops new work the moment it happens — for the API, readiness says no and the sockets are
   * told to come back — registered once there is an application to stop.
   */
  readonly onCrash: (stop: () => void) => void;
}

const CRASHED = 'an error escaped every handler; exiting';

/**
 * An error that escaped every handler — a rejected promise nobody awaited, an exception thrown from a
 * timer or a socket callback — leaves the process in a state nothing was written for (#634). It is
 * logged once, reported to the error tracker as urgent, new work is refused, the tracker is flushed
 * within a deadline, and the process exits 1 for its supervisor to start a clean one. Carrying on
 * half-alive is the silent failure this exists to prevent; what stops new work is asked to, and is not
 * waited for, since it is the code whose state is now unknown.
 */
export const installCrashHandlers = ({
  log,
  report,
  flush,
  process,
  deadlineMs,
  timers = systemTimers,
}: Crash): CrashHandle => {
  let exiting = false;
  let stop: (() => void) | null = null;

  /** Said, whatever the reason is: a reason the logger cannot walk is said without it. */
  const say = (kind: string, reason: unknown): void => {
    try {
      log.error(CRASHED, { err: reason, kind });
      report(CRASHED, { err: reason, kind });
    } catch {
      log.error(CRASHED, { kind, describing: 'the reason could not be described' });
      report(CRASHED, { kind, describing: 'the reason could not be described' });
    }
  };

  const crashed = (kind: 'unhandledRejection' | 'uncaughtException', reason: unknown): void => {
    const first = !exiting;
    exiting = true;
    say(kind, reason);
    if (!first) return;
    try {
      stop?.();
    } catch (failure) {
      log.warn('new work could not be stopped while exiting', { err: failure });
    }
    const deadline = timers.set(() => {
      process.exit(1);
    }, deadlineMs);
    void flush()
      .catch((failure: unknown) => {
        // At `warn`: a report that failed must not be reported in turn. The exit still follows.
        log.warn('the error tracker could not be flushed while exiting', { err: failure });
      })
      .finally(() => {
        timers.clear(deadline);
        process.exit(1);
      });
  };
  process.on('unhandledRejection', (reason) => {
    crashed('unhandledRejection', reason);
  });
  process.on('uncaughtException', (error) => {
    crashed('uncaughtException', error);
  });
  return {
    crashed: (): boolean => exiting,
    onCrash: (next): void => {
      stop = next;
    },
  };
};

/**
 * The application's drain, with the server's settings closed to change first: a change that would
 * start now builds and swaps a pair the process is about to drop, so it is refused, said as
 * `shutting-down` (D-179 §4.9). A change already under way finishes; the drain waits for its request.
 */
export const drainRefusingChanges =
  (services: Pick<RuntimeHolder, 'refuseChanges'>, drain: () => Promise<void>) =>
  async (): Promise<void> => {
    services.refuseChanges();
    await drain();
  };

/** What a drained process still holds, closed by `closeAfterDrain` in this order. */
export interface HeldAfterDrain {
  /** Pushes for writes already committed (D-126); absent where push is off. */
  readonly push?: { readonly flush: () => Promise<void> } | undefined;
  /** The mail ledger of every relay the process served with (`modules/setup/runtime.ts`). */
  readonly services: Pick<RuntimeHolder, 'sends'>;
  readonly errorTracker: { readonly flush: () => Promise<unknown> };
  readonly database: { readonly destroy: () => Promise<void> };
}

/**
 * The shutdown's second half: pushes, then every letter still on its way — the current relay's and
 * those of relays the settings replaced, posted by work that started on them — each within its own
 * bound, then the reports of the shutdown itself, then the pool.
 */
export const closeAfterDrain =
  ({ push, services, errorTracker, database }: HeldAfterDrain) =>
  async (): Promise<void> => {
    await push?.flush();
    await services.sends.flush();
    await errorTracker.flush();
    await database.destroy();
  };
