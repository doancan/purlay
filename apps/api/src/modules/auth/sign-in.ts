/**
 * Signing out, as the decisions they are. Signing in is the library's (`better-auth.ts`, D-179);
 * these end sessions by their rows, as the library does, and tell the sockets they held.
 *
 * `ingress/http/auth.ts` reads a request, calls one of these and turns the outcome
 * into cookies; nothing here knows a request exists (`ARCHITECTURE.md` §4).
 */
import type { Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import { publishSessionsEnded, type EventBus } from '../../platform/events';
import { revokeAllSessions, revokeSession } from './sessions';

/** Signing out also reaches the sockets the revoked sessions hold. */
export interface SignOutDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly bus: EventBus;
}

/**
 * Ends this session, by its row, if the request had one. Signing out with no session is not an
 * error: the outcome asked for is already true.
 */
export const signOut = async (
  { database, clock, bus }: SignOutDependencies,
  sessionId: string | undefined,
): Promise<void> => {
  if (sessionId === undefined) return;
  // Its devices go with the row (0024's cascade): a shared computer does not go on showing the last
  // person's notices (D-126).
  const revoked = await revokeSession(database, sessionId);
  // After the revocation is written, so a socket is never closed for a sign-out
  // that did not happen (#194).
  if (revoked !== undefined) await publishSessionsEnded(bus, clock, [revoked]);
};

/** Signing out *everywhere* knows whose sessions to end, so it takes the owner. */
export const signOutEverywhere = async (
  { database, clock, bus }: SignOutDependencies,
  userId: string,
): Promise<void> => {
  const revoked = await revokeAllSessions(database, userId);
  await publishSessionsEnded(bus, clock, revoked);
};
