/** A removed source disappears immediately; old in-flight reads cannot put it back. */
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type { SharedPage } from '@purlay/types';
import { families } from './keys';

export const forgetSharedSource = (client: QueryClient, messageId: string): void => {
  const interrupted = client
    .getQueryCache()
    .findAll({ queryKey: families.shared })
    .filter((query) => query.state.data === undefined && query.state.fetchStatus !== 'idle');
  void client.cancelQueries({ queryKey: families.shared });
  for (const [key, held] of client.getQueriesData<InfiniteData<SharedPage>>({
    queryKey: families.shared,
  })) {
    if (held === undefined) continue;
    client.setQueryData<InfiniteData<SharedPage>>(key, {
      ...held,
      pages: held.pages.map((page) => ({
        ...page,
        data: page.data.filter((item) => item.messageId !== messageId),
      })),
    });
  }
  // readAgain refreshes retained pages. A cancelled first read has no data for it to refresh.
  // Wait until the caller has invalidated the family, then resume only still-active interrupted reads.
  if (interrupted.length > 0)
    queueMicrotask(() => {
      for (const query of interrupted)
        void client.refetchQueries({ queryKey: query.queryKey, exact: true, type: 'active' });
    });
};
