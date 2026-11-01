/**
 * How long a session lives, as the server's administrator set it (D-244): signed out after so many hours unused,
 * and after so many days from its sign-in whatever its use. Both are off unless set, and a session then lives as
 * `SESSION_TTL_DAYS` made it, as every session did before.
 *
 * **Judged when the session is read, from its own row.** Nothing is written into `sessions` when the policy
 * changes: `created_at` and `last_used_at` say all the policy needs, so a change reaches every session already open
 * from the next request, and turning a rule off gives back a session it had not yet ended.
 *
 * **What counts as use** is a request the session resolves for — every HTTP route and the socket's upgrade go
 * through `sessionFromHeaders` — and the page saying the person is in front of it (the socket's `ACTIVE`, D-143),
 * which a person reading and writing over an open socket sends and nothing else does. A socket merely open is not
 * use: a tab left open overnight is what the idle timeout is for. `last_used_at` is written at most every
 * `ACTIVITY_STALE_AFTER_MS` while a timeout is set (D-60's hour otherwise), so a session is signed out between
 * that much before the timeout and the timeout after its last use — never a write on every request.
 *
 * **Ended as every end is.** A lapsed session is deleted by its row, and only while the row still says it lapsed
 * (`endLapsedSession`), so two requests at the instant end it once and a use that refreshed it in between keeps it;
 * the sockets it held are told `SESSION_ENDED { reason: 'expired' }`, and the liveness sweep ends one whose session
 * lapsed with nobody asking (`realtime/liveness.ts`).
 */
import type { Executor } from '@purlay/db';
import type { SessionIdleTimeoutHours, SessionMaxAgeDays } from '@purlay/types';

/** The two rules, each `null` when off. Field names as the settings and the contract spell them. */
export interface SessionLifetime {
  readonly sessionIdleTimeoutHours: SessionIdleTimeoutHours | null;
  readonly sessionMaxAgeDays: SessionMaxAgeDays | null;
}

/** Neither rule on: what every server was before D-244, and what a test's instance is unless it says. */
export const NO_SESSION_LIFETIME: SessionLifetime = {
  sessionIdleTimeoutHours: null,
  sessionMaxAgeDays: null,
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How stale `last_used_at` may get while an idle timeout is set before a use refreshes it. Five minutes of an hour
 * — the shortest timeout — is precise enough to be fair, and one write a session every five minutes is nothing
 * beside the requests that cause it (D-60 keeps the hour when no timeout is set).
 */
export const ACTIVITY_STALE_AFTER_MS = 5 * 60 * 1000;

/** The instants before which a session's use, and its sign-in, end it now; `undefined` where that rule is off. */
export const lapseCutoffs = (
  lifetime: SessionLifetime,
  now: Date,
): { readonly usedBy: Date | undefined; readonly createdBy: Date | undefined } => ({
  usedBy:
    lifetime.sessionIdleTimeoutHours === null
      ? undefined
      : new Date(now.getTime() - lifetime.sessionIdleTimeoutHours * HOUR_MS),
  createdBy:
    lifetime.sessionMaxAgeDays === null
      ? undefined
      : new Date(now.getTime() - lifetime.sessionMaxAgeDays * DAY_MS),
});

/** Whether either rule is on: with neither, nothing here reads or writes anything. */
export const lifetimeLimited = (lifetime: SessionLifetime): boolean =>
  lifetime.sessionIdleTimeoutHours !== null || lifetime.sessionMaxAgeDays !== null;

/**
 * Whether the policy has ended this session at `now`: unused for the whole timeout, or as old as the maximum age.
 * The instant itself is past it, so a test of a boundary has one answer on each side.
 */
export const lapsed = (
  lifetime: SessionLifetime,
  session: { readonly createdAt: Date; readonly lastUsedAt: Date },
  now: Date,
): boolean => {
  const { usedBy, createdBy } = lapseCutoffs(lifetime, now);
  return (
    (usedBy !== undefined && session.lastUsedAt.getTime() <= usedBy.getTime()) ||
    (createdBy !== undefined && session.createdAt.getTime() <= createdBy.getTime())
  );
};

/**
 * When the session ends whatever is done with it: its own expiry or the maximum age, whichever is first. What a
 * socket's timer is set to, and what the device list shows; the idle end moves with use, so it is the sweep's.
 */
export const fixedEnd = (
  lifetime: SessionLifetime,
  session: { readonly createdAt: Date; readonly expiresAt: Date },
): Date =>
  lifetime.sessionMaxAgeDays === null
    ? session.expiresAt
    : new Date(
        Math.min(
          session.expiresAt.getTime(),
          session.createdAt.getTime() + lifetime.sessionMaxAgeDays * DAY_MS,
        ),
      );

/**
 * Deletes the session if its row, as it stands now, says the policy ended it; whether this call deleted it, so
 * its sockets are told once. Judged again in the statement, not from what the caller read: a use that refreshed it
 * in between keeps it, and of two requests at the instant only one deletes it.
 */
export const endLapsedSession = async (
  executor: Executor,
  lifetime: SessionLifetime,
  now: Date,
  sessionId: string,
): Promise<boolean> => {
  const { usedBy, createdBy } = lapseCutoffs(lifetime, now);
  if (usedBy === undefined && createdBy === undefined) return false;
  const ended = await executor
    .deleteFrom('sessions')
    .where('id', '=', sessionId)
    .where((row) =>
      row.or([
        ...(usedBy === undefined ? [] : [row('last_used_at', '<=', usedBy)]),
        ...(createdBy === undefined ? [] : [row('created_at', '<=', createdBy)]),
      ]),
    )
    .returning('id')
    .executeTakeFirst();
  return ended !== undefined;
};

/**
 * The person used the session without a request resolving it — the page said they are in front of it (`ACTIVE`):
 * `last_used_at` moves, at most every `ACTIVITY_STALE_AFTER_MS`, while an idle timeout is set. Never for a session
 * the policy has already ended: use does not bring one back. Nothing at all with no timeout set (D-60 as it was).
 */
export const noteSessionActivity = async (
  executor: Executor,
  lifetime: SessionLifetime,
  now: Date,
  sessionId: string,
): Promise<void> => {
  const { usedBy, createdBy } = lapseCutoffs(lifetime, now);
  if (usedBy === undefined) return;
  const refresh = executor
    .updateTable('sessions')
    .set({ last_used_at: now })
    .where('id', '=', sessionId)
    .where('last_used_at', '<', new Date(now.getTime() - ACTIVITY_STALE_AFTER_MS))
    .where('last_used_at', '>', usedBy);
  await (createdBy === undefined ? refresh : refresh.where('created_at', '>', createdBy)).execute();
};
