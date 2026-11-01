/**
 * The liveness sweep: a socket whose session was removed **without a bus event** — by the recovery
 * command (`bun run admin:reset-password`, another process with no bus) or an operator's SQL — would
 * otherwise stay open until its session's `expires_at`, since the hub resolves identity once, at open
 * (`hub.ts`). Every `SWEEP_INTERVAL_MS` this asks the database about the sessions of **all** open
 * sockets in one query (batches of at most `SWEEP_BATCH_MAX`, never one per socket) and ends, with the
 * same `SESSION_ENDED` frame and close code every other end of a session uses, each socket whose
 * session row is gone or expired or whose account is erased — and one whose session the server's lifetime
 * policy ended (D-244): unused past the idle timeout, which use elsewhere moves and no timer of the hub's can
 * know, or older than a maximum age set after the socket opened. The row is left to the next request that
 * presents the session, which deletes it (`session-lifetime.ts`).
 *
 * A query that fails is logged and tried again at the next tick, and **closes nothing**: an unreadable
 * database is not a reason to sign everybody out. **No socket, no timer**: a tick is scheduled when a
 * socket opens and again only while any is open. The timer does not keep the process alive and is
 * cleared by `stop`, which shutdown calls.
 */
import type { Executor } from '@purlay/db';
import type { ServerFrame } from '@purlay/types';
import type { Clock } from '../platform/clock';
import type { Logger } from '../platform/logging';
import { lapsed, type SessionLifetime } from '../modules/auth/session-lifetime';
import type { Timers } from './hub';

/** How often open sockets' sessions are checked: an end by SQL is seen within about half a minute. */
const SWEEP_INTERVAL_MS = 30_000;

/** The most sessions asked about in one query. */
export const SWEEP_BATCH_MAX = 1_000;

/** What the sweep reads of the hub, and how it ends a socket. */
export interface LivenessSource {
  readonly sessions: () => readonly { readonly socketId: string; readonly sessionId: string }[];
  readonly end: (socketId: string, frame: ServerFrame) => void;
  /** How long a session lives on the server now (D-244): read at each tick, so a change applies at the next. */
  readonly lifetime: () => SessionLifetime;
}

/** One-shot timers that do not keep the process alive. */
const unreferencedTimers: Timers<ReturnType<typeof setTimeout>> = {
  set: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref();
    return handle;
  },
  clear: (handle) => {
    clearTimeout(handle);
  },
};

export interface LivenessSweep {
  /** One pass now: what a tick runs. Resolves when its queries are done. */
  readonly tick: () => Promise<void>;
  /** A socket opened: makes sure a tick is waiting. Idle between sockets, the sweep holds no timer. */
  readonly arm: () => void;
  readonly stop: () => void;
}

export const startLivenessSweep = ({
  database,
  source,
  clock,
  log,
  timers = unreferencedTimers,
  intervalMs = SWEEP_INTERVAL_MS,
}: {
  readonly database: Executor;
  readonly source: LivenessSource;
  readonly clock: Clock;
  readonly log: Logger;
  readonly timers?: Timers;
  readonly intervalMs?: number;
}): LivenessSweep => {
  let handle: unknown;
  let stopped = false;

  const tick = async (): Promise<void> => {
    const open = source.sessions();
    for (let from = 0; from < open.length; from += SWEEP_BATCH_MAX) {
      const batch = open.slice(from, from + SWEEP_BATCH_MAX);
      const rows = await database
        .selectFrom('sessions')
        .innerJoin('users', 'users.id', 'sessions.user_id')
        .select([
          'sessions.id',
          'sessions.expires_at',
          'sessions.created_at',
          'sessions.last_used_at',
          'users.deleted_at',
        ])
        .where('sessions.id', 'in', [...new Set(batch.map((one) => one.sessionId))])
        .execute();
      const known = new Map(rows.map((row) => [row.id, row]));
      const now = clock.now().getTime();
      const lifetime = source.lifetime();
      for (const { socketId, sessionId } of batch) {
        const row = known.get(sessionId);
        const reason =
          row === undefined
            ? 'signed-out'
            : row.deleted_at !== null
              ? 'account-deleted'
              : new Date(row.expires_at).getTime() <= now ||
                  lapsed(
                    lifetime,
                    { createdAt: row.created_at, lastUsedAt: row.last_used_at },
                    new Date(now),
                  )
                ? 'expired'
                : undefined;
        if (reason !== undefined) {
          source.end(socketId, { event: 'SESSION_ENDED', data: { reason }, ts: now });
        }
      }
    }
  };

  /** Whether a tick is waiting to run: there is never more than one, and none while nobody is connected. */
  let waiting = false;
  const schedule = (): void => {
    if (stopped || waiting) return;
    waiting = true;
    handle = timers.set(() => {
      waiting = false;
      void tick()
        .catch((error: unknown) => {
          log.error('the socket liveness sweep failed; it tries again at the next tick', {
            err: error,
          });
        })
        .finally(() => {
          // Only while somebody is connected: a server with no socket has no timer at all.
          if (source.sessions().length > 0) schedule();
        });
    }, intervalMs);
  };

  return {
    tick,
    arm: schedule,
    stop: (): void => {
      stopped = true;
      timers.clear(handle);
    },
  };
};
