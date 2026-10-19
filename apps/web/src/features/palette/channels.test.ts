/**
 * The order channels are listed and stepped through, and the names they go by.
 */
import { erasedPerson } from '@purlay/types';
import { describe, expect, test } from 'bun:test';
import type { Channel } from '@purlay/types';
import { ALICE, BOB, IDS, ME, aChannel } from '../../testing/fixtures';
import { displayName, inSidebarOrder, stepUnread } from './channels';

const unread = (n: number): Channel['state'] => ({
  lastReadMessageId: null,
  unreadCount: n,
  unreadMentionCount: 0,
});

const names = (channels: readonly Channel[]): (string | null)[] => channels.map((c) => c.name);

describe('the sidebar order', () => {
  test('is channels by name, then direct messages newest first (D-160)', () => {
    const list = [
      aChannel('1', 'beta', { lastMessageAt: '2026-09-09T08:00:00.000Z' }),
      aChannel('2', 'alpha', { lastMessageAt: '2026-09-09T08:00:00.000Z' }),
      aChannel('3', 'newest', { lastMessageAt: '2026-09-09T09:00:00.000Z' }),
      aChannel('4', 'quiet'),
      aChannel('5', null, {
        type: 'direct_message',
        peer: ALICE,
        lastMessageAt: '2026-09-09T10:00:00.000Z',
      }),
      aChannel('6', null, { type: 'direct_message', peer: ME }),
    ];
    expect(names(inSidebarOrder(list))).toEqual(['alpha', 'beta', 'newest', 'quiet', null, null]);
    expect(inSidebarOrder(list).map((c) => c.id)).toEqual(['2', '1', '3', '4', '5', '6']);
  });

  test('leaves out what the person has not joined', () => {
    expect(
      inSidebarOrder([aChannel('1', 'api'), aChannel('2', 'elsewhere', { state: null })]).map(
        (c) => c.id,
      ),
    ).toEqual(['1']);
  });
});

describe('stepping to the next unread channel', () => {
  const ordered = [
    aChannel('a', 'a', { state: unread(0) }),
    aChannel('b', 'b', { state: unread(2) }),
    aChannel('c', 'c', { state: unread(0) }),
    aChannel('d', 'd', { state: unread(1) }),
  ];

  test('goes forward to the next with something unread, and back to the previous', () => {
    expect(stepUnread(ordered, 'a', 1)?.id).toBe('b');
    expect(stepUnread(ordered, 'b', 1)?.id).toBe('d');
    expect(stepUnread(ordered, 'd', -1)?.id).toBe('b');
  });

  test('wraps round either end', () => {
    expect(stepUnread(ordered, 'd', 1)?.id).toBe('b');
    expect(stepUnread(ordered, 'b', -1)?.id).toBe('d');
  });

  test('from somewhere that is not in the list, starts at the end it is travelling from', () => {
    expect(stepUnread(ordered, null, 1)?.id).toBe('b');
    expect(stepUnread(ordered, null, -1)?.id).toBe('d');
    expect(stepUnread(ordered, 'elsewhere', 1)?.id).toBe('b');
  });

  test('goes nowhere when nothing else is unread, including when only this one is', () => {
    expect(stepUnread([aChannel('a', 'a', { state: unread(0) })], 'a', 1)).toBeNull();
    expect(stepUnread([aChannel('a', 'a', { state: unread(3) })], 'a', 1)).toBeNull();
    expect(stepUnread([], null, 1)).toBeNull();
  });

  test('a channel the person has not joined is never a stop', () => {
    expect(stepUnread([aChannel('a', 'a', { state: null })], null, 1)).toBeNull();
  });
});

describe('the name a channel goes by', () => {
  test('is its own, or the other person\'s in a direct message, or "you" for a note to self', () => {
    expect(displayName(aChannel(IDS.api, 'api'), IDS.me, 'you', 'deleted')).toBe('api');
    expect(
      displayName(
        aChannel('x', null, { type: 'direct_message', peer: ALICE }),
        IDS.me,
        'you',
        'deleted',
      ),
    ).toBe('Alice');
    expect(
      displayName(
        aChannel('x', null, { type: 'direct_message', peer: ME }),
        IDS.me,
        'you',
        'deleted',
      ),
    ).toBe('you');
  });

  test('is its people in a group (D-127)', () => {
    expect(
      displayName(
        aChannel('x', null, { type: 'direct_message', peers: [ALICE, BOB] }),
        IDS.me,
        'you',
        'deleted',
      ),
    ).toBe(`${ALICE.displayName}, ${BOB.displayName}`);
  });

  test('names an erased person “deleted user”, in the reader’s words (D-139 §5)', () => {
    expect(
      displayName(
        aChannel('x', null, { type: 'direct_message', peer: erasedPerson(ALICE.id) }),
        IDS.me,
        'you',
        'Silinmiş kullanıcı',
      ),
    ).toBe('Silinmiş kullanıcı');
  });

  test('is empty when there is nothing to call it', () => {
    expect(displayName(aChannel('x', null), IDS.me, 'you', 'deleted')).toBe('');
    expect(
      displayName(aChannel('x', null, { type: 'direct_message' }), IDS.me, 'you', 'deleted'),
    ).toBe('');
  });
});
