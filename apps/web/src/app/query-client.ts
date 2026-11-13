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
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { workspaceAccessRequired } from '../data/access-change';
import { isApiError, isTransient } from '../data/errors';
import { keys } from '../data/keys';

/** How long a fetched page counts as fresh. */
export const STALE_AFTER_MS = 30_000;

/**
 * A module's route the server has closed answers `404 ROUTE_NOT_FOUND`, where a missing thing answers its own code
 * (`CHANNEL_NOT_FOUND`): in a rolling deploy with different `MODULES` that is a page drawn from a node that runs the
 * module reaching one that does not (D-250, `DEPLOY.md`). The session is read again, once, so a server that no longer
 * lists the module has it hidden by `ModuleGate` and the person is not left on "no longer available". One that still
 * lists it is a mixed cluster, and nothing more is done: this reads `me` and never answers a failure of `me` itself, so
 * it cannot loop, and a read already under way is the answer a burst of 404s waits for.
 */
const rereadSessionOnClosedRoute = (client: QueryClient, error: unknown): void => {
  if (isApiError(error) && error.code === 'WORKSPACE_ACCESS_REQUIRED' && error.workspaceId !== null)
    workspaceAccessRequired(client, error.workspaceId);
  if (!isApiError(error) || error.code !== 'ROUTE_NOT_FOUND') return;
  if (client.isFetching({ queryKey: keys.me, exact: true }) > 0) return;
  void client.invalidateQueries({ queryKey: keys.me, exact: true });
};

export const createQueryClient = ({
  retries = 1,
}: { readonly retries?: number } = {}): QueryClient => {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query): void => {
        if (query.queryKey[0] === keys.me[0]) return;
        rereadSessionOnClosedRoute(client, error);
      },
    }),
    mutationCache: new MutationCache({
      onError: (error): void => {
        rereadSessionOnClosedRoute(client, error);
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: STALE_AFTER_MS,
        refetchOnWindowFocus: false,
        retry: (failures, error) => failures < retries && isTransient(error),
      },
    },
  });
  return client;
};
