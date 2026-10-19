/** `?message=` — a link to one message (D-149), spelled and read beside `?thread=`. */
import { describe, expect, test } from 'bun:test';
import { matchRoute, messageHref, messageInSearch } from './routes';

const ID = '0199155c-6202-7b7f-8c11-2a4d3f9e1b70';

describe('the address of a message', () => {
  test("is the channel's own address with the message named, and a route that still matches", () => {
    const href = messageHref('acme', 'c1', ID);
    expect(href).toBe(`/w/acme/c/c1?message=${ID}`);
    expect(matchRoute(href.split('?')[0] ?? '')).toEqual({
      name: 'channel',
      params: { slug: 'acme', channelId: 'c1' },
    });
  });

  test('is read back from the search, and only when it names an id', () => {
    expect(messageInSearch(`?message=${ID}`)).toBe(ID);
    expect(messageInSearch(`?x=1&message=${ID}`)).toBe(ID);
    expect(messageInSearch('')).toBeNull();
    expect(messageInSearch('?message=')).toBeNull();
    expect(messageInSearch('?message=not-an-id')).toBeNull();
    expect(messageInSearch(`?message=${ID}x`)).toBeNull();
    expect(messageInSearch('?message=<script>')).toBeNull();
    expect(messageInSearch(`?thread=${ID}`)).toBeNull();
  });
});
