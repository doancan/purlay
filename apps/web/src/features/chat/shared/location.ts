/** The address keeps the tab and filters; cursors stay in the bounded page cache. */
import { Value } from '@sinclair/typebox/value';
import { SharedFilters } from '@purlay/types';
import { href } from '../../../router/routes';

export const sharedLocation = (
  search: string,
): { readonly filters: SharedFilters; readonly invalid: boolean } => {
  const params = new URLSearchParams(search);
  const input: unknown = Object.fromEntries([
    ['view', params.get('view') ?? 'files'],
    ...['q', 'channelId', 'senderId', 'type', 'since', 'until'].flatMap((key) => {
      const value = params.get(key);
      return value === null || value === '' ? [] : [[key, value]];
    }),
  ]);
  if (
    Value.Check(SharedFilters, input) &&
    [input.since, input.until].every(
      (date) => date === undefined || Number.isFinite(Date.parse(date)),
    )
  )
    return { filters: input, invalid: false };
  return { filters: { view: params.get('view') === 'links' ? 'links' : 'files' }, invalid: true };
};

export const sharedHref = (slug: string, filters: SharedFilters): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== '') params.set(key, value);
  return `${href('shared', { slug })}?${params.toString()}`;
};
