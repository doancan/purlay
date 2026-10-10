/**
 * The server-state cache and what it does by default (D-18).
 *
 * Two defaults matter to a chat client and neither is TanStack's:
 *
 * - **No refetch on window focus.** The socket is what keeps a channel current; a
 *   refetch every time somebody tabs back would re-download pages the socket has
 *   already delivered and could reorder a list under a reader (`UX.md` §1, "never
 *   move content under the reader").
 * - **A short stale time**, so moving between channels reuses what is cached —
 *   the 100 ms channel-switch budget (`PRD.md` §5) is only reachable if the second
 *   visit does not wait on the network.
 *
 * Retries are one, not three, and only for what a retry can fix: the transport already
 * reconnects, and a request that fails twice in a row is better shown as an error with a
 * Retry button (`UX.md` §8) than hidden behind seconds of silent attempts. A 404 or a 401
 * is the same answer the second time, so it is not asked for again. A test passes
 * `retries: 0`.
 */
import { QueryClient } from '@tanstack/react-query';
import { isTransient } from '../data/errors';

/** How long a fetched page counts as fresh. */
export const STALE_AFTER_MS = 30_000;

export const createQueryClient = ({
  retries = 1,
}: { readonly retries?: number } = {}): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_AFTER_MS,
        refetchOnWindowFocus: false,
        retry: (failures, error) => failures < retries && isTransient(error),
      },
    },
  });
