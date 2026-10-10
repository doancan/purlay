/** `?thread=` — the one query parameter the client defines, spelled and read in one place. */
import { describe, expect, test } from 'bun:test';
import { matchRoute, threadHref, threadInSearch } from './routes';

const ID = '0199155c-6202-7b7f-8c11-2a4d3f9e1b70';

describe('the address of a thread', () => {
  test("is the channel's own address with the root named, and a route that still matches", () => {
    const href = threadHref('acme', 'c1', ID);
    expect(href).toBe(`/w/acme/c/c1?thread=${ID}`);
    expect(matchRoute(href.split('?')[0] ?? '')).toEqual({
      name: 'channel',
      params: { slug: 'acme', channelId: 'c1' },
    });
  });

  test('is read back from the search, and only when it names an id', () => {
    expect(threadInSearch(`?thread=${ID}`)).toBe(ID);
    expect(threadInSearch(`?x=1&thread=${ID}`)).toBe(ID);
    expect(threadInSearch('')).toBeNull();
    expect(threadInSearch('?thread=')).toBeNull();
    expect(threadInSearch('?thread=not-an-id')).toBeNull();
    expect(threadInSearch('?thread=<script>')).toBeNull();
    expect(threadInSearch('?other=1')).toBeNull();
  });
});
