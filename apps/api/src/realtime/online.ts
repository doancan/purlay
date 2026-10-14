/**
 * Who is online, on this node (#480, D-136): a person with at least one socket open here. Ephemeral
 * and in memory (D-7). The hub, which already counts each person's sockets, says when a person's
 * first opens and their last closes; this decides what that means:
 *
 * - **The first socket** makes them online, told at once — unless their last closed less than
 *   `PRESENCE_GRACE_MS` ago, when nothing changed and nothing is told: a reload, a reconnect, a tab
 *   moved between windows is not somebody leaving and coming back.
 * - **The last socket closing** makes them offline after the grace, told then, if no socket came back.
 * - **Every change has a version** that only grows on this node, even across a clock stepped back, so
 *   a client that hears an "online" after the "offline" that followed it keeps the offline.
 *
 * Telling is the caller's (`announce`): reading who shares a workspace and publishing. It is awaited
 * by `settled`, so a drain and a test know when it is done; `stop` cancels every grace not yet run.
 *
 * **One node** (D-25): on two, each node knows only its own sockets, and a person online on one is
 * offline to the other — wrong, which `ARCHITECTURE.md` §6.1 does not allow for long; the reads are
 * async so the shared adapter (Phase 3, over the bus) replaces this without its callers changing.
 */
import { PRESENCE_GRACE_MS, type PresenceChange } from '@purlay/types';
import type { Clock } from '../platform/clock';
import type { Logger } from '../platform/logging';
import { after, type Timers } from './hub';

export interface OnlinePresence {
  /** The person's first socket on this node opened. */
  readonly arrived: (userId: string) => void;
  /** The person's last socket on this node closed. */
  readonly left: (userId: string) => void;
  /** Which of these people are online now, each at the version that said so. */
  readonly onlineAmong: (userIds: readonly string[]) => Promise<readonly PresenceChange[]>;
  /** The version now: anybody not online is offline at it. */
  readonly version: () => number;
  /** Cancels every grace not yet run: the process is stopping. */
  readonly stop: () => void;
  /** Resolves when every announcement made so far is done. */
  readonly settled: () => Promise<void>;
  /** How much is held: for the leak check, and a gauge one day. */
  readonly held: () => { readonly online: number; readonly leaving: number };
}

/** How many times a change that could not be told is tried again, and the first wait. */
const PRESENCE_RETRIES = 3;
const PRESENCE_RETRY_MS = 1_000;

export interface OnlineOptions {
  readonly clock: Clock;
  readonly timers: Timers;
  readonly log: Logger;
  /** Tells the people who share a workspace with `change.userId`. */
  readonly announce: (change: PresenceChange) => Promise<void>;
  readonly graceMs?: number;
}

export const onlinePresence = ({
  clock,
  timers,
  log,
  announce,
  graceMs = PRESENCE_GRACE_MS,
}: OnlineOptions): OnlinePresence => {
  /** Online now, with the version that said so. */
  const online = new Map<string, number>();
  /** Their last socket closed; cancelling this keeps them online. */
  const leaving = new Map<string, () => void>();
  const running = new Set<Promise<void>>();
  // Stopping: the sockets the drain closes leave no grace behind them, and tell nobody.
  let stopped = false;
  /** The largest version a change was given. */
  let last = 0;
  /** The largest version a snapshot was read at: every later change is larger than it. */
  let read = 0;
  const next = (): number => {
    last = Math.max(last + 1, read + 1, clock.now().getTime());
    return last;
  };
  /** The change last made for each person, until it is told: a retry only tells what is still true. */
  const latest = new Map<string, number>();
  /** Retries waiting: cancelled when the node stops. */
  const retries = new Set<() => void>();

  const tell = (change: PresenceChange, attempt = 0): void => {
    latest.set(change.userId, change.version);
    const told: Promise<void> = announce(change)
      .then(() => {
        if (latest.get(change.userId) === change.version) latest.delete(change.userId);
      })
      .catch((error: unknown) => {
        // Not dropped: a co-member would be wrong about this person until their next change, which
        // may be hours. Tried again, a few times, while it is still what is true (D-136 §7).
        const again = attempt < PRESENCE_RETRIES && !stopped;
        log.error(
          again ? 'presence could not be told; trying again' : 'presence could not be told',
          {
            userId: change.userId,
            attempt,
            err: error,
          },
        );
        if (!again) {
          if (latest.get(change.userId) === change.version) latest.delete(change.userId);
          return;
        }
        const cancel = after(timers, PRESENCE_RETRY_MS * 2 ** attempt, () => {
          retries.delete(cancel);
          if (latest.get(change.userId) === change.version) tell(change, attempt + 1);
        });
        retries.add(cancel);
      })
      .finally(() => {
        running.delete(told);
      });
    running.add(told);
  };

  return {
    arrived: (userId): void => {
      if (stopped) return;
      const cancel = leaving.get(userId);
      if (cancel !== undefined) {
        // Back inside the grace: nothing changed for anybody.
        cancel();
        leaving.delete(userId);
        return;
      }
      if (online.has(userId)) return;
      const version = next();
      online.set(userId, version);
      tell({ userId, online: true, version });
    },

    left: (userId): void => {
      if (stopped || !online.has(userId) || leaving.has(userId)) return;
      const cancel = after(timers, graceMs, () => {
        leaving.delete(userId);
        online.delete(userId);
        tell({ userId, online: false, version: next() });
      });
      leaving.set(userId, cancel);
    },

    onlineAmong: async (userIds) =>
      await Promise.resolve(
        userIds.flatMap((userId) => {
          const version = online.get(userId);
          return version === undefined ? [] : [{ userId, online: true, version }];
        }),
      ),

    // Read, not taken: a snapshot moves no counter, and every change after it is larger (`next`).
    version: (): number => {
      read = Math.max(read, last, clock.now().getTime());
      return read;
    },

    stop: (): void => {
      stopped = true;
      for (const cancel of leaving.values()) cancel();
      leaving.clear();
      for (const cancel of retries) cancel();
      retries.clear();
    },

    settled: async (): Promise<void> => {
      while (running.size > 0) await Promise.allSettled([...running]);
    },

    held: () => ({ online: online.size, leaving: leaving.size + retries.size }),
  };
};
