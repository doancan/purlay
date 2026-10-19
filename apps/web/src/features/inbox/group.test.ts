/**
 * Gathering one thread's replies (D-162): which notifications become one row, where the row sits,
 * and what it says about the people in it.
 */
import { describe, expect, test } from 'bun:test';
import type { Notification } from '@purlay/types';
import { ALICE, BOB, IDS, aMessage, aUser, messageIdAt } from '../../testing/fixtures';
import { groupInbox, repliersOf } from './group';

const CAROL = aUser('carol', '00000000-0000-4000-8000-0000000000e4');

const id = (n: number): string =>
  `00000000-0000-4000-8000-${(0xc00 + n).toString(16).padStart(12, '0')}`;

/** Notification `n`, told at `at`; a reply in thread `root` when one is given. */
const told = (
  n: number,
  at: string,
  over: { root?: number; type?: Notification['type']; sender?: typeof ALICE } = {},
): Notification => ({
  id: id(n),
  type: over.type ?? (over.root === undefined ? 'mention' : 'thread_reply'),
  channelId: IDS.api,
  message: aMessage(n, {
    sender: over.sender ?? ALICE,
    parentId: over.root === undefined ? null : messageIdAt(over.root),
  }),
  thread:
    over.root === undefined
      ? null
      : { rootId: messageIdAt(over.root), excerpt: 'the question', authorId: IDS.me },
  createdAt: at,
  readAt: null,
});

const shape = (list: readonly Notification[]): string[][] =>
  groupInbox(list).map((row) => row.members.map((n) => n.id));

describe('one thread’s replies, gathered', () => {
  test('a thread’s replies on one day are one row, where its newest is', () => {
    const list = [
      told(6, '2026-09-09T16:00:00', { root: 1 }),
      told(5, '2026-09-09T15:00:00'),
      told(4, '2026-09-09T14:00:00', { root: 1 }),
      told(3, '2026-09-09T13:00:00', { root: 2 }),
      told(2, '2026-09-09T12:00:00', { root: 1 }),
    ];
    expect(shape(list)).toEqual([[id(6), id(4), id(2)], [id(5)], [id(3)]]);
    expect(groupInbox(list)[0]?.newest.id).toBe(id(6));
  });

  test('another day is another row: a group never says one time for yesterday and today', () => {
    const list = [
      told(3, '2026-09-09T09:00:00', { root: 1 }),
      told(2, '2026-09-08T18:00:00', { root: 1 }),
      told(1, '2026-09-08T17:00:00', { root: 1 }),
    ];
    expect(shape(list)).toEqual([[id(3)], [id(2), id(1)]]);
  });

  test('only replies are gathered: a mention in a thread is said on its own', () => {
    const list = [
      told(3, '2026-09-09T10:00:00', { root: 1, type: 'mention' }),
      told(2, '2026-09-09T09:00:00', { root: 1 }),
      told(1, '2026-09-09T08:00:00', { root: 1, type: 'mention' }),
    ];
    expect(shape(list)).toEqual([[id(3)], [id(2)], [id(1)]]);
  });

  test('every key is its own, so React can tell the rows apart', () => {
    const rows = groupInbox([
      told(2, '2026-09-09T10:00:00', { root: 1 }),
      told(1, '2026-09-09T09:00:00', { root: 1 }),
    ]);
    expect(rows.map((row) => row.key)).toEqual([id(2)]);
  });
});

describe('who replied', () => {
  test('each person once, newest first; past two, the rest are counted', () => {
    const at = '2026-09-09T10:00:00';
    expect(
      repliersOf(
        [
          told(4, at, { root: 1, sender: CAROL }),
          told(3, at, { root: 1, sender: ALICE }),
          told(2, at, { root: 1, sender: CAROL }),
          told(1, at, { root: 1, sender: BOB }),
        ],
        'deleted user',
      ),
    ).toEqual({ shown: ['Carol', 'Alice'], more: 1 });
    expect(repliersOf([told(1, at, { root: 1, sender: BOB })], 'deleted user')).toEqual({
      shown: ['Bob'],
      more: 0,
    });
  });
});
