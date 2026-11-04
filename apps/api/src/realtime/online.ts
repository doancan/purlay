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
 * **Away is idleness** (D-257): a person whose page has not spoken for `AWAY_AFTER_MS` is told away, at a
 * new version, and told active again at once on the page's next word (`active`). Here `away` is idleness
 * only; the person's own choice is the announcer's to add. A socket back inside the grace changes nothing,
 * idle or not; a person who went offline forgets it, and arrives active. Alone on a node this is decided
 * here, by one timer per person. Across nodes the shared record decides, and only what it answers is told: a
 * word that ended a told idle, and the idle lapses a renewal's sweep finds (up to a renewal late), so two
 * nodes never both tell. The node still keeps when each person's page last spoke here, to answer from
 * while the record cannot be reached.
 *
 * Telling is the caller's (`announce`): reading who shares a workspace and publishing. It is awaited
 * by `settled`, so a drain and a test know when it is done; `stop` cancels every grace not yet run.
 *
 * **One node, or several** (D-25, D-201): alone, each node knows only its own sockets. With a
 * `PresenceDirectory` (`redis-presence.ts`) a person is online while any node holds a socket of theirs: the
 * first socket on any node tells, the last on the last node tells after the grace, and a second node
 * holding them changes nothing. Each node keeps its entries alive while it runs and they lapse by
 * themselves when it dies, so a dead node's people are read as offline within `PRESENCE_NODE_TTL_MS`, and
 * every node's renewal also sweeps: whoever finds a person whose last claim lapsed tells their co-members,
 * once. A node that stops gives its claims up, so a deploy is told within a renewal. A directory that cannot
 * be reached never stops a socket from opening: the node answers from what it knows itself, and says so.
 */
import { AWAY_AFTER_MS, PRESENCE_GRACE_MS, type PresenceChange } from '@purlay/types';
import type { Clock } from '../platform/clock';
import type { Logger } from '../platform/logging';
import { after, type Timers } from './hub';

/**
 * Who is online across nodes: the shared record behind `OnlinePresence`. Every answer is a version that
 * only grows across the whole cluster, taken from the record's own clock. Rejects when it cannot answer.
 */
export interface PresenceDirectory {
  /**
   * This node holds a socket of theirs: the version when nobody did, null when somebody already did. Somebody
   * nobody held arrives active, quiet for `awayAfterMs` from now; a second node or a renewal changes neither.
   */
  readonly join: (userId: string, awayAfterMs: number) => Promise<number | null>;
  /** This node holds none now: the version when nobody does, null when another node still does. */
  readonly leave: (userId: string) => Promise<number | null>;
  /**
   * A page of theirs spoke: they are quiet for `awayAfterMs` from now. The version when this ended an idle that
   * was told, null otherwise, and null for somebody nobody holds.
   */
  readonly active: (userId: string, awayAfterMs: number) => Promise<number | null>;
  /** Their state at a new version, when somebody holds them; null when nobody does. */
  readonly retell: (userId: string) => Promise<PresenceChange | null>;
  /** Which of these people are online on any node, each at the version that said so, and whether idle. */
  readonly among: (userIds: readonly string[]) => Promise<readonly PresenceChange[]>;
  /** A version every later change is larger than. */
  readonly version: () => Promise<number>;
  /** This node is stopping: its claims are given up, and anybody it alone held is due to be told offline. */
  readonly release: (userIds: readonly string[]) => Promise<void>;
  /**
   * People whose last claim lapsed and whom nobody has told of: a node that died, was stopped, or could not
   * say they left. Each is returned once, to whoever asks first, at the version that says they are offline.
   * And people still held whose page has been quiet for their `awayAfterMs`, returned once, online and away.
   */
  readonly sweep: () => Promise<readonly PresenceChange[]>;
}

/** How long a node's claim on a person lasts without being renewed, and so how stale a dead node's people are. */
export const PRESENCE_NODE_TTL_MS = 30_000;
/** A node renews what it holds three times in that. */
const DIRECTORY_RENEW_MS = PRESENCE_NODE_TTL_MS / 3;

export interface OnlinePresence {
  /** The person's first socket on this node opened. */
  readonly arrived: (userId: string) => void;
  /** The person's last socket on this node closed. */
  readonly left: (userId: string) => void;
  /** The person's page spoke: their idle window starts again, and if they were told away they are told active at once. */
  readonly active: (userId: string) => void;
  /** Tells the person's current state again at a new version (their choice changed); nothing if offline. */
  readonly retell: (userId: string) => Promise<void>;
  /** Which of these people are online now, each at the version that said so. */
  readonly onlineAmong: (userIds: readonly string[]) => Promise<readonly PresenceChange[]>;
  /** The version now: anybody not online is offline at it. */
  readonly version: () => number | Promise<number>;
  /** Cancels every grace not yet run: the process is stopping. */
  readonly stop: () => void;
  /** Resolves when every announcement made so far is done. */
  readonly settled: () => Promise<void>;
  /** How much is held: for the leak check, and a gauge one day. */
  readonly held: () => { readonly online: number; readonly leaving: number };
}

/** Presence of a process that does not run what tells it: nobody is online, nothing is held, nobody is told. */
export const offlinePresence: OnlinePresence = {
  arrived: () => undefined,
  left: () => undefined,
  active: () => undefined,
  retell: () => Promise.resolve(),
  onlineAmong: () => Promise.resolve([]),
  version: () => 0,
  stop: () => undefined,
  settled: () => Promise.resolve(),
  held: () => ({ online: 0, leaving: 0 }),
};

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
  /** How long a person's page may be quiet before they are told away. */
  readonly awayAfterMs?: number;
  /** The shared record, with Redis; without it, this node's own is the whole answer. */
  readonly directory?: PresenceDirectory;
}

export const onlinePresence = ({
  clock,
  timers,
  log,
  announce,
  graceMs = PRESENCE_GRACE_MS,
  awayAfterMs = AWAY_AFTER_MS,
  directory,
}: OnlineOptions): OnlinePresence => {
  /** Online now, with the version that said so. */
  const online = new Map<string, number>();
  /** Their last socket closed; cancelling this keeps them online. */
  const leaving = new Map<string, () => void>();
  /** Told idle, on this node alone: forgotten when they go offline. */
  const idle = new Set<string>();
  /** One timer per online person: when it runs they have been quiet for `awayAfterMs`. */
  const idleTimers = new Map<string, () => void>();
  /** When each person online here last spoke here: what this node answers from while the record is away. */
  const spoke = new Map<string, number>();
  const running = new Set<Promise<void>>();
  // Stopping: the sockets the drain closes leave no grace behind them, and tell nobody.
  let stopped = false;
  /** The largest version a change was given. */
  let last = 0;
  /** The largest version a snapshot was read at: every later change is larger than it. */
  let read = 0;
  /** A version the shared record gave: this node's own, if it must make one, is larger than it. */
  const seen = (version: number): number => {
    last = Math.max(last, version);
    return version;
  };
  const next = (): number => {
    last = Math.max(last + 1, read + 1, clock.now().getTime());
    return last;
  };
  /**
   * Starts a person's idle window again. Only without a directory: with one, idleness is held with the
   * online claims, which is the cross-node path (not here).
   */
  const armIdle = (userId: string): void => {
    idleTimers.get(userId)?.();
    const cancel = after(timers, awayAfterMs, () => {
      idleTimers.delete(userId);
      if (stopped || !online.has(userId)) return;
      idle.add(userId);
      const version = next();
      online.set(userId, version);
      tell({ userId, online: true, away: true, version });
    });
    idleTimers.set(userId, cancel);
  };
  const forgetIdle = (userId: string): void => {
    idleTimers.get(userId)?.();
    idleTimers.delete(userId);
    idle.delete(userId);
  };
  /** Idle as this node alone knows it: told idle here, or, with a record, quiet here for `awayAfterMs`. */
  const idleHere = (userId: string): boolean =>
    directory === undefined
      ? idle.has(userId)
      : clock.now().getTime() - (spoke.get(userId) ?? clock.now().getTime()) >= awayAfterMs;
  /** The change last made for each person, until it is told: a retry only tells what is still true. */
  const latest = new Map<string, number>();
  /** Retries waiting: cancelled when the node stops. */
  const retries = new Set<() => void>();
  /** One person's directory calls, one after another: a join is never overtaken by the leave after it. */
  const turns = new Map<string, Promise<void>>();
  const inTurn = (userId: string, work: () => Promise<void>): void => {
    const turn: Promise<void> = (turns.get(userId) ?? Promise.resolve())
      .then(work)
      .catch((error: unknown) => {
        log.error('presence could not be recorded', { userId, err: error });
      })
      .finally(() => {
        running.delete(turn);
        if (turns.get(userId) === turn) turns.delete(userId);
      });
    turns.set(userId, turn);
    running.add(turn);
  };

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

  /**
   * Keeps this node's claim on everybody it holds alive, so a node that dies stops claiming them. A person
   * whose claim had lapsed meanwhile (this node was stalled) is online again to the rest, and is told.
   */
  let cancelRenewal = (): void => undefined;
  if (directory !== undefined) {
    const renew = (): void => {
      if (stopped) return;
      for (const userId of online.keys()) {
        inTurn(userId, async () => {
          let joined: number | null;
          try {
            joined = await directory.join(userId, awayAfterMs);
          } catch (error) {
            // The next renewal tries again; the link has said that Redis is away.
            log.debug('presence could not be renewed', { userId, err: error });
            return;
          }
          if (joined !== null && online.has(userId)) {
            tell({ userId, online: true, away: false, version: seen(joined) });
          }
        });
      }
      sweepLapsed();
      cancelRenewal = after(timers, DIRECTORY_RENEW_MS, renew);
    };
    /**
     * Tells of people nobody held any longer and nobody told of: a node died, or stopped, or could not say; and
     * of people quiet everywhere for `awayAfterMs`, whom nobody has told away.
     */
    const sweepLapsed = (): void => {
      const swept: Promise<void> = directory
        .sweep()
        .then((gone) => {
          for (const change of gone) tell({ ...change, version: seen(change.version) });
        })
        .catch((error: unknown) => {
          log.debug('presence could not be swept', { err: error });
        })
        .finally(() => {
          running.delete(swept);
        });
      running.add(swept);
    };
    cancelRenewal = after(timers, DIRECTORY_RENEW_MS, renew);
  }

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
      spoke.set(userId, clock.now().getTime());
      if (directory === undefined) {
        armIdle(userId);
        tell({ userId, online: true, away: false, version });
        return;
      }
      inTurn(userId, async () => {
        let joined: number | null;
        try {
          joined = await directory.join(userId, awayAfterMs);
        } catch (error) {
          // They are online here whatever the record says: told, at this node's own version.
          log.warn('presence could not reach the shared record; telling from this node alone', {
            userId,
            err: error,
          });
          joined = version;
        }
        if (joined !== null) tell({ userId, online: true, away: false, version: seen(joined) });
        await Promise.resolve();
      });
    },

    left: (userId): void => {
      if (stopped || !online.has(userId) || leaving.has(userId)) return;
      const cancel = after(timers, graceMs, () => {
        leaving.delete(userId);
        online.delete(userId);
        spoke.delete(userId);
        if (directory === undefined) {
          forgetIdle(userId);
          tell({ userId, online: false, away: false, version: next() });
          return;
        }
        inTurn(userId, async () => {
          let left: number | null;
          try {
            left = await directory.leave(userId);
          } catch (error) {
            // Not told: another node may still hold them, which this node cannot know. Their claim here
            // lapses by itself within `PRESENCE_NODE_TTL_MS`, and every read excludes it from then on.
            log.warn('presence could not reach the shared record; not telling they left', {
              userId,
              err: error,
            });
            return;
          }
          if (left !== null) tell({ userId, online: false, away: false, version: seen(left) });
          await Promise.resolve();
        });
      });
      leaving.set(userId, cancel);
    },

    active: (userId): void => {
      if (stopped || !online.has(userId)) return;
      spoke.set(userId, clock.now().getTime());
      if (directory === undefined) {
        armIdle(userId);
        if (!idle.delete(userId)) return;
        const version = next();
        online.set(userId, version);
        tell({ userId, online: true, away: false, version });
        return;
      }
      // The record decides, for every node: told only when this word ended an idle that was told.
      inTurn(userId, async () => {
        let ended: number | null;
        try {
          ended = await directory.active(userId, awayAfterMs);
        } catch (error) {
          // Nothing told: the next word, or the next sweep, puts it right.
          log.warn('presence could not reach the shared record; the word is not recorded', {
            userId,
            err: error,
          });
          return;
        }
        if (ended !== null) tell({ userId, online: true, away: false, version: seen(ended) });
      });
    },

    retell: (userId): Promise<void> => {
      if (stopped) return Promise.resolve();
      if (directory === undefined) {
        if (!online.has(userId)) return Promise.resolve();
        const version = next();
        online.set(userId, version);
        tell({ userId, online: true, away: idle.has(userId), version });
        return Promise.resolve();
      }
      // Asked of the record, not of this node: the person may be held only by another.
      return new Promise<void>((resolve) => {
        inTurn(userId, async () => {
          try {
            let change: PresenceChange | null;
            try {
              change = await directory.retell(userId);
            } catch (error) {
              log.warn(
                'presence could not reach the shared record; retelling from this node alone',
                {
                  userId,
                  err: error,
                },
              );
              if (!online.has(userId)) return;
              const version = next();
              online.set(userId, version);
              change = { userId, online: true, away: idleHere(userId), version };
            }
            if (change !== null) tell({ ...change, version: seen(change.version) });
          } finally {
            resolve();
          }
        });
      });
    },

    onlineAmong: async (userIds): Promise<readonly PresenceChange[]> => {
      if (directory !== undefined) {
        try {
          return await directory.among(userIds);
        } catch (error) {
          log.warn('presence could not reach the shared record; answering from this node alone', {
            err: error,
          });
        }
      }
      return userIds.flatMap((userId) => {
        const version = online.get(userId);
        return version === undefined
          ? []
          : [{ userId, online: true, away: idleHere(userId), version }];
      });
    },

    // Read, not taken: a snapshot moves no counter, and every change after it is larger (`next`).
    version: (): number | Promise<number> => {
      const local = (): number => {
        read = Math.max(read, last, clock.now().getTime());
        return read;
      };
      if (directory === undefined) return local();
      return directory
        .version()
        .then((version) => {
          read = Math.max(read, version);
          return seen(version);
        })
        .catch((error: unknown) => {
          log.warn('presence could not reach the shared record; versioning from this node', {
            err: error,
          });
          return local();
        });
    },

    stop: (): void => {
      stopped = true;
      for (const cancel of leaving.values()) cancel();
      leaving.clear();
      for (const cancel of idleTimers.values()) cancel();
      idleTimers.clear();
      for (const cancel of retries) cancel();
      retries.clear();
      cancelRenewal();
      if (directory !== undefined && online.size > 0) {
        // The claims of a node that is going are given up, so the room is told within a sweep, not a lapse.
        const released: Promise<void> = directory
          .release([...online.keys()])
          .catch((error: unknown) => {
            log.warn('presence claims could not be released; they lapse by themselves', {
              err: error,
            });
          })
          .finally(() => {
            running.delete(released);
          });
        running.add(released);
      }
    },

    settled: async (): Promise<void> => {
      while (running.size > 0) await Promise.allSettled([...running]);
    },

    held: () => ({ online: online.size, leaving: leaving.size + retries.size }),
  };
};
