/** Accepted mutations beat earlier reads; one-time credentials never enter a query cache. */
import type { IncomingWebhook, OutgoingWebhook } from '@purlay/types';
import type { QueryClient } from '@tanstack/react-query';

export const acceptWebhook = async (
  client: QueryClient,
  key: readonly unknown[],
  id: string,
  row: IncomingWebhook | OutgoingWebhook | null,
): Promise<void> => {
  await client.cancelQueries({ queryKey: key, exact: true });
  client.setQueryData<(IncomingWebhook | OutgoingWebhook)[]>(key, (current) => {
    const previous = current ?? [];
    if (row === null) return previous.filter((item) => item.id !== id);
    return previous.some((item) => item.id === id)
      ? previous.map((item) => (item.id === id ? row : item))
      : [...previous, row];
  });
  await client.invalidateQueries({ queryKey: key, exact: true });
};
