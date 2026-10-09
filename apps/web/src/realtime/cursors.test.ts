import { describe, expect, test } from 'bun:test';
import { messageId } from '@purlay/types';
import { createCursors } from './cursors';

const at = (milliseconds: number): string =>
  messageId(new Date(Date.parse('2026-10-09T12:00:00.000Z') + milliseconds));

describe('cursors', () => {
  test('a channel nothing was seen in has none', () => {
    expect(createCursors().get('a')).toBeNull();
  });

  test('the cursor is the highest id seen, whatever order they arrive in', () => {
    const cursors = createCursors();
    const [first, second, third] = [at(0), at(1_000), at(2_000)];
    for (const id of [second, third, first]) cursors.observe('a', id);
    expect(cursors.get('a')).toBe(third);
  });

  test('a late arrival with a lower id does not move it back', () => {
    const cursors = createCursors();
    const high = at(5_000);
    cursors.observe('a', high);
    cursors.observe('a', at(1_000));
    expect(cursors.get('a')).toBe(high);
  });

  test('channels are independent', () => {
    const cursors = createCursors();
    cursors.observe('a', at(0));
    expect(cursors.get('b')).toBeNull();
  });

  test('upper case and lower case of one id are the same cursor', () => {
    const cursors = createCursors();
    const id = at(0);
    cursors.observe('a', id.toUpperCase());
    expect(cursors.get('a')).toBe(id);
  });
});
