/**
 * When an open tab in the background tells its person something (D-148): only what the badges
 * already count as needing them, only while they are away from the page, never in Deep Work, and one
 * notice per conversation — or one for all of them — rather than a storm.
 */
import { describe, expect, test } from 'bun:test';
import type { Channel, Notification } from '@purlay/types';
import {
  badgeOf,
  isAway,
  newestFor,
  planOf,
  risen,
  settled,
  summaryTag,
  tagOf,
  waitingOf,
  type Moment,
} from './decide';

const channel = (id: string, unreadMentionCount: number | null): Pick<Channel, 'id' | 'state'> => ({
  id,
  state:
    unreadMentionCount === null
      ? null
      : { lastReadMessageId: null, unreadCount: unreadMentionCount + 3, unreadMentionCount },
});

const AWAY: Moment = { on: true, quiet: false, away: true };

describe('what rose', () => {
  test('a conversation whose badge went up, and only that one', () => {
    const before = waitingOf([channel('a', 0), channel('b', 2), channel('c', 1)]);
    const after = waitingOf([channel('a', 1), channel('b', 2), channel('c', 0)]);
    expect(risen(before, after)).toEqual(['a']);
  });

  test('a conversation that appeared already waiting rose from nothing', () => {
    expect(risen(waitingOf([]), waitingOf([channel('new', 1)]))).toEqual(['new']);
  });

  test('plain unread messages are not something that needs the person', () => {
    // The badge counts mentions, direct messages and answers (NEEDS_YOU); `unreadCount` is not it.
    const before = waitingOf([channel('a', 0)]);
    const after = waitingOf([
      { id: 'a', state: { lastReadMessageId: null, unreadCount: 40, unreadMentionCount: 0 } },
    ]);
    expect(risen(before, after)).toEqual([]);
  });

  test('a conversation read on another device has settled, and its notice goes', () => {
    const before = waitingOf([channel('a', 2), channel('b', 1)]);
    const after = waitingOf([channel('a', 0), channel('b', 1)]);
    expect(settled(before, after)).toEqual(['a']);
  });

  test('a conversation that left the list has settled too', () => {
    expect(settled(waitingOf([channel('gone', 1)]), waitingOf([]))).toEqual(['gone']);
  });
});

describe('whether to interrupt', () => {
  test('one conversation rose while the person is away: one notice for it', () => {
    expect(planOf(['a'], AWAY)).toEqual({ kind: 'one', channelId: 'a' });
  });

  test('several at once — a reconnect, a busy minute — is one notice, not a storm', () => {
    expect(planOf(['a', 'b', 'c'], AWAY)).toEqual({ kind: 'many', count: 3 });
  });

  test('nothing rose, nothing is said', () => {
    expect(planOf([], AWAY)).toEqual({ kind: 'none' });
  });

  test('in front of the person, the page itself says it', () => {
    expect(planOf(['a'], { ...AWAY, away: false })).toEqual({ kind: 'none' });
  });

  test('never in Deep Work', () => {
    expect(planOf(['a'], { ...AWAY, quiet: true })).toEqual({ kind: 'none' });
  });

  test('never where the person has not turned notifications on here', () => {
    expect(planOf(['a'], { ...AWAY, on: false })).toEqual({ kind: 'none' });
  });

  test('away is a hidden page, or one that is shown but not focused', () => {
    expect(isAway({ visibilityState: 'hidden', hasFocus: () => true })).toBe(true);
    expect(isAway({ visibilityState: 'visible', hasFocus: () => false })).toBe(true);
    expect(isAway({ visibilityState: 'visible', hasFocus: () => true })).toBe(false);
  });
});

describe('coalescing', () => {
  test('a conversation has one tag, so its next notice replaces the last', () => {
    expect(tagOf('a')).toBe(tagOf('a'));
    expect(tagOf('a')).not.toBe(tagOf('b'));
  });

  test('the summary has one tag per workspace, never a conversation’s', () => {
    expect(summaryTag('w1')).not.toBe(summaryTag('w2'));
    expect(summaryTag('a')).not.toBe(tagOf('a'));
  });
});

describe('what it says', () => {
  const note = (
    over: Partial<Notification> & { readonly sender: string; readonly at: string },
  ): Notification =>
    ({
      id: `n-${over.at}`,
      type: over.type ?? 'mention',
      channelId: over.channelId ?? 'a',
      createdAt: over.at,
      readAt: over.readAt ?? null,
      message: {
        id: `m-${over.at}`,
        channelId: over.channelId ?? 'a',
        sender: { id: over.sender },
      },
    }) as unknown as Notification;

  test('the newest unread notification of that conversation that needs the person', () => {
    const page = [
      note({ sender: 'alice', at: '3', channelId: 'b' }),
      note({ sender: 'bob', at: '2', type: 'thread_resolved' }),
      note({ sender: 'carol', at: '1' }),
      note({ sender: 'dave', at: '0' }),
    ];
    expect(newestFor(page, 'a', 'me')?.id).toBe('n-1');
  });

  test('never one of the person’s own messages', () => {
    const page = [note({ sender: 'me', at: '2' }), note({ sender: 'alice', at: '1' })];
    expect(newestFor(page, 'a', 'me')?.id).toBe('n-1');
    expect(newestFor([note({ sender: 'me', at: '2' })], 'a', 'me')).toBeNull();
  });

  test('not one already read', () => {
    expect(newestFor([note({ sender: 'alice', at: '1', readAt: '5' })], 'a', 'me')).toBeNull();
  });
});

describe('the badge on the icon', () => {
  test('is the count that needs the person, and nothing in Deep Work', () => {
    expect(badgeOf(3, false)).toBe(3);
    expect(badgeOf(3, true)).toBe(0);
    expect(badgeOf(0, false)).toBe(0);
  });
});
