/** Shared pages are disposable source views. A cancelled old read cannot repopulate revoked content. */
import {
  useInfiniteQuery,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from '@tanstack/react-query';
import type { SharedFilters, SharedPage } from '@purlay/types';
import { useApi } from '../../../data/api-provider';
import { keys } from '../../../data/keys';

export const useShared = (
  workspaceId: string,
  filters: SharedFilters,
  enabled: boolean,
): UseInfiniteQueryResult<InfiniteData<SharedPage>> => {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: keys.shared(workspaceId, filters),
    queryFn: async ({ pageParam, signal }) => {
      const page = await api.shared(workspaceId, { ...filters, before: pageParam }, signal);
      signal.throwIfAborted();
      return page;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) => page.indexing) === true ? 2000 : false,
    enabled,
  });
};
