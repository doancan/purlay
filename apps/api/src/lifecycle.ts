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
      process.exit(0);
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
  /** The logger whose `error` reaches the error tracker. */
  readonly log: Logger;
  /** Sends what the tracker holds, so the report of this crash leaves before the process does. */
  readonly flush: () => Promise<void>;
  readonly process: CrashProcess;
  /** How long the flush may take: a collector that does not answer must not keep a broken process up. */
  readonly deadlineMs: number;
  readonly timers?: Timers;
}

/**
 * An error that escaped every handler — a rejected promise nobody awaited, an exception thrown from a
 * timer or a socket callback — leaves the process in a state nothing was written for (#634). It is
 * logged once as an error, so the error tracker hears it (the tracker is reached only through
 * `log.error`), the tracker is flushed within a deadline, and the process exits 1 for its supervisor
 * to start a clean one. Carrying on half-alive is the silent failure this exists to prevent; a drain
 * is not attempted, since the code that would drain is the code whose state is now unknown.
 */
export const installCrashHandlers = ({
  log,
  flush,
  process,
  deadlineMs,
  timers = systemTimers,
}: Crash): void => {
  let exiting = false;
  const crashed = (kind: 'unhandledRejection' | 'uncaughtException', reason: unknown): void => {
    log.error('an error escaped every handler; exiting', { err: reason, kind });
    if (exiting) return;
    exiting = true;
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
};
