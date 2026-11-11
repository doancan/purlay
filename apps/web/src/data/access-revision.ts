/** A client-local revision invalidates content work begun under previous access; it grants nothing. */
import { useCallback, useSyncExternalStore } from 'react';
import type { Query, QueryClient, QueryKey } from '@tanstack/react-query';

interface Revision {
  value: number;
  readonly listeners: Set<() => void>;
}

// One counter per client, with only mounted subscribers. It cannot disappear during an old request
// as a garbage-collected query could, and neither reset timestamps nor query counters can cause ABA.
const revisions = new WeakMap<QueryClient, Revision>();
const queryAccess = new WeakMap<Query, object>();
const revisionOn = (client: QueryClient): Revision => {
  let revision = revisions.get(client);
  if (revision === undefined) {
    revision = { value: 0, listeners: new Set() };
    revisions.set(client, revision);
  }
  return revision;
};

const accessRevision = (client: QueryClient): number => revisions.get(client)?.value ?? 0;

/** A reset changes this marker; removal/replacement changes the query identity. Neither can cause ABA. */
export const captureAccess = (client: QueryClient, queryKey: QueryKey): (() => boolean) => {
  const cache = client.getQueryCache();
  const query = cache.get(client.defaultQueryOptions({ queryKey }).queryHash);
  if (query === undefined) return (): boolean => false;
  const captured = queryAccess.get(query) ?? {};
  queryAccess.set(query, captured);
  return (): boolean => cache.get(query.queryHash) === query && queryAccess.get(query) === captured;
};

export const invalidateAccess = (queries: readonly Query[]): void => {
  for (const query of queries) queryAccess.set(query, {});
};

export const advanceAccessRevision = (client: QueryClient): void => {
  const revision = revisionOn(client);
  revision.value += 1;
  for (const listener of [...revision.listeners]) listener();
};

export const watchAccessChanges = (client: QueryClient, listener: () => void): (() => void) => {
  const revision = revisionOn(client);
  revision.listeners.add(listener);
  return (): void => {
    revision.listeners.delete(listener);
  };
};

/** Providers discard old optimistic content in the same render that observes the new revision. */
export const useAccessRevision = (client: QueryClient): number => {
  const subscribe = useCallback(
    (listener: () => void): (() => void) => {
      return watchAccessChanges(client, listener);
    },
    [client],
  );
  const snapshot = useCallback((): number => accessRevision(client), [client]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
};
