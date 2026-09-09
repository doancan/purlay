/**
 * The socket hub: which connection belongs to whom, and how a frame reaches one.
 *
 * **It never touches the database for anything but identity, and never touches a
 * service.** Services publish to the bus; the hub subscribes and delivers. That
 * separation is what makes a later move to a shared bus a one-file change (D-7).
 *
 * Identity is resolved lazily and remembered per connection. Admission has
 * already refused anything without a valid session **before the socket was
 * bound** (`upgrade.ts`), so this is a second read of a decision already made
 * rather than the decision itself — and doing it here means the hub does not
 * depend on carrying a value from the handshake into the connection, which is
 * framework plumbing that would be verified once and then quietly change.
 */
import type { ServerFrame } from '@purlay/types';
import type { Executor } from '@purlay/db';
import type { Clock } from '../platform/clock';
import { resolveSession } from '../modules/auth/sessions';
import { sessionTokenFrom } from '../ingress/http/cookies';
import type { SocketIdentity } from './router';

export interface SocketHub {
  /** Registers how to reach this connection. */
  opened: (socketId: string, send: (payload: string) => void) => void;
  /** Who is on this connection, or nothing if the session has since gone. */
  identify: (socketId: string, request: Request) => Promise<SocketIdentity | undefined>;
  closed: (socketId: string) => void;
  /** What the bus delivers through. */
  deliver: (socketId: string, frame: ServerFrame) => void;
  readonly size: () => number;
}

export const createSocketHub = (database: Executor, clock: Clock): SocketHub => {
  const send = new Map<string, (payload: string) => void>();
  const identities = new Map<string, SocketIdentity>();

  return {
    opened: (socketId: string, sendPayload: (payload: string) => void): void => {
      send.set(socketId, sendPayload);
    },

    identify: async (socketId: string, request: Request): Promise<SocketIdentity | undefined> => {
      const known = identities.get(socketId);
      if (known !== undefined) return known;

      const token = sessionTokenFrom(request.headers.get('cookie'));
      const owner = token === undefined ? undefined : await resolveSession(database, clock, token);
      if (owner === undefined) return undefined;

      const identity: SocketIdentity = { socketId, userId: owner.userId };
      identities.set(socketId, identity);
      return identity;
    },

    closed: (socketId: string): void => {
      send.delete(socketId);
      identities.delete(socketId);
    },

    deliver: (socketId: string, frame: ServerFrame): void => {
      // A frame for a connection that has gone is dropped, not queued. Delivery
      // is best-effort by design: what a client missed it asks for on reconnect,
      // by keyset (`ARCHITECTURE.md` §5.4).
      send.get(socketId)?.(JSON.stringify(frame));
    },

    size: (): number => send.size,
  };
};
