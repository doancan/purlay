/**
 * Who is in front of a workspace's page now (D-143): a word holds for its window and not a moment
 * past it, for its workspace only, and what has run out is let go.
 */
import { describe, expect, test } from 'bun:test';
import { ACTIVE_EVERY_MS } from '@purlay/types';
import { aMovableClock } from '../testing/doubles';
import { ACTIVE_WINDOW_MS, inMemoryAttention, nobodyActive } from './attention';

describe('attention', () => {
  test('a word holds for two of the client’s intervals, and not at the end of them', () => {
    expect(ACTIVE_WINDOW_MS).toBe(2 * ACTIVE_EVERY_MS);
    const clock = aMovableClock();
    const attention = inMemoryAttention(clock);
    expect(attention.active('ada', 'acme')).toBe(false);
    attention.heard('ada', 'acme');
    clock.advance(ACTIVE_WINDOW_MS - 1);
    expect(attention.active('ada', 'acme')).toBe(true);
    clock.advance(1);
    expect(attention.active('ada', 'acme')).toBe(false);
  });

  test('for the workspace it was said in, and the person who said it', () => {
    const attention = inMemoryAttention(aMovableClock());
    attention.heard('ada', 'acme');
    expect(attention.active('ada', 'globex')).toBe(false);
    expect(attention.active('bob', 'acme')).toBe(false);
  });

  test('a later word renews it; what ran out is let go, so memory is the people active now', () => {
    const clock = aMovableClock();
    const attention = inMemoryAttention(clock);
    attention.heard('ada', 'acme');
    attention.heard('bob', 'acme');
    clock.advance(ACTIVE_EVERY_MS);
    attention.heard('ada', 'acme');
    clock.advance(ACTIVE_EVERY_MS);
    expect(attention.active('ada', 'acme')).toBe(true);
    expect(attention.active('bob', 'acme')).toBe(false);
    expect(attention.held()).toBe(1);
  });

  test('where nothing hears, nobody is active', () => {
    nobodyActive.heard('ada', 'acme');
    expect(nobodyActive.active('ada', 'acme')).toBe(false);
  });
});
