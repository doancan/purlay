/**
 * A body is read once a session, however often its row mounts (#46): the reading cache is keyed by
 * the text, bounded, and keeps what was used last.
 */
import { describe, expect, test } from 'bun:test';
import { readBody } from './render-content';
import { readingCache } from './reading-cache';

const counting = (): { read: (text: string) => string; reads: string[] } => {
  const reads: string[] = [];
  return {
    reads,
    read: (text): string => {
      reads.push(text);
      return `read:${text}`;
    },
  };
};

describe('the reading cache', () => {
  test('reads a text once, and answers the same reading after', () => {
    const { read, reads } = counting();
    const cached = readingCache(read, 3);
    expect(cached('a')).toBe('read:a');
    expect(cached('a')).toBe('read:a');
    expect(reads).toEqual(['a']);
  });

  test('an edited text is a new text: read again', () => {
    const { read, reads } = counting();
    const cached = readingCache(read, 3);
    cached('before');
    cached('after');
    expect(reads).toEqual(['before', 'after']);
  });

  test('is bounded: past the limit the one used longest ago goes, and a recent use keeps one', () => {
    const { read, reads } = counting();
    const cached = readingCache(read, 2);
    cached('a');
    cached('b');
    cached('a'); // used again: now the newest
    cached('c'); // over the limit: b, the oldest, goes
    cached('a');
    expect(reads).toEqual(['a', 'b', 'c']);
    cached('b');
    expect(reads).toEqual(['a', 'b', 'c', 'b']);
  });

  test('the bodies drawn in the feed are read through it: the same text is the same reading', () => {
    const text = `a body read twice ${String(Math.random())}`;
    expect(readBody(text)).toBe(readBody(text));
  });
});
