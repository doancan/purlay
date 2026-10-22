/**
 * "Sign out my other devices", answered by Purlay (D-179 §3).
 *
 * The library's own `/revoke-other-sessions` lists the person's sessions by user and then deletes
 * each by its token. Under the session-hash plugin (`@purlay/db`'s `sessionTokenHashing`) a row read
 * by user carries the digest, the delete hashes it again, nothing matches, and the route still
 * answers `{ status: true }` — a silent no-op on a security path, reproduced in the spike's fix
 * round. This endpoint ends the same sessions by row: the caller's user, every id but the
 * session it was called with. No token is read, so no digest can ever be taken for one.
 *
 * It is a plugin endpoint under the library's own key and path. The library builds its endpoint
 * table with the plugins' endpoints spread after its own (`api/index.mjs`, 1.7.12), so this one
 * replaces the built-in for the HTTP route and for `auth.api.revokeOtherSessions` alike; the
 * documentation (concepts/plugins) asks for unique paths and says nothing of replacing one, so a
 * test pins that the route answering is this one (`sessions.integration.test.ts`).
 *
 * The rows it deletes are its own statement, not the library's, so the library's delete hooks never
 * see them: the sessions it ends are told to their sockets through `ended`, as every other end is
 * (D-85) — each page of ids found, deleted by exactly those ids, so none is ended unannounced.
 */
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthEndpoint, sensitiveSessionMiddleware } from 'better-auth/api';

/** How many sessions one statement ends. */
const PAGE = 100;

export const revokeOtherSessionsById = (
  ended: (sessionIds: readonly string[]) => Promise<void>,
): BetterAuthPlugin => ({
  id: 'purlay-revoke-other-sessions',
  endpoints: {
    revokeOtherSessions: createAuthEndpoint(
      '/revoke-other-sessions',
      // The built-in's middleware: the session is read from the database, never a cached copy.
      { method: 'POST', requireHeaders: true, use: [sensitiveSessionMiddleware] },
      async (ctx) => {
        const { session } = ctx.context.session;
        // A page at a time — the adapter reads at most a hundred rows unasked — until none is left,
        // each page deleted by exactly its ids and then announced.
        for (;;) {
          const others = await ctx.context.adapter.findMany<{ id: string }>({
            model: 'session',
            where: [
              { field: 'userId', value: session.userId },
              { field: 'id', operator: 'ne', value: session.id },
            ],
            select: ['id'],
            limit: PAGE,
          });
          const ids = others.map((other) => other.id);
          if (ids.length === 0) break;
          await ctx.context.adapter.deleteMany({
            model: 'session',
            where: [
              { field: 'userId', value: session.userId },
              { field: 'id', operator: 'in', value: ids },
            ],
          });
          // Not inside a transaction: the delete above is committed when it returns.
          await ended(ids);
        }
        return await ctx.json({ status: true });
      },
    ),
  },
});
