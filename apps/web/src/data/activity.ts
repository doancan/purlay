/** Foreground pages are explicit new reads, never background resets or automatic retries. */
import type { QueryClient, QueryKey } from '@tanstack/react-query';

// A reset discards data, but not the Query. Weak keys disappear with the actual query lifecycle.
const attempted = new WeakMap<object, Set<string | undefined>>();

export const isNewPageRequest = (client: QueryClient, key: QueryKey, page: unknown): boolean => {
  const query = client.getQueryCache().find({ queryKey: key, exact: true });
  const encoded = JSON.stringify(page);
  const seen = query === undefined ? undefined : attempted.get(query);
  if (seen?.has(encoded)) return false;
  if (query !== undefined) {
    const pages = seen ?? new Set<string | undefined>();
    pages.add(encoded);
    attempted.set(query, pages);
  }
  const held = client.getQueryData<{ readonly pageParams: readonly unknown[] }>(key);
  return !held?.pageParams.some((existing) => JSON.stringify(existing) === encoded);
};
