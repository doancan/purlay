/** What the sidebar lists and in what order: the rules, without a render. */
import { describe, expect, test } from 'bun:test';
import {
  QUESTION_COUNT_CAP,
  joinableChannels,
  joinedChannels,
  starredChannels,
  people,
  shownQuestionCount,
} from './ordering';
import { ALICE, BOB, ME, aChannel, someMembers } from '../../testing/fixtures';
import type { Channel } from '@purlay/types';

const at = (minute: number): string => new Date(Date.UTC(2026, 8, 9, 8, minute)).toISOString();
const names = (list: readonly { name: string | null }[]): (string | null)[] =>
  list.map((c) => c.name);

describe('channels the person is in', () => {
  test('most recently active first, then by name, so a silent list never shuffles', () => {
    const list = joinedChannels([
      aChannel('1', 'zeta'),
      aChannel('2', 'alpha'),
      aChannel('3', 'old', { lastMessageAt: at(1) }),
      aChannel('4', 'new', { lastMessageAt: at(9) }),
    ]);
    expect(names(list)).toEqual(['new', 'old', 'alpha', 'zeta']);
  });

  test('leaves out what they have not joined, and direct messages, which are people', () => {
    const list = joinedChannels([
      aChannel('1', 'api'),
      aChannel('2', 'elsewhere', { state: null }),
      aChannel('3', null, { type: 'direct_message', peer: ALICE }),
      aChannel('4', 'secret', { type: 'private' }),
    ]);
    expect(names(list)).toEqual(['api', 'secret']);
  });

  test('a channel with no name sorts without throwing', () => {
    expect(joinedChannels([aChannel('1', null), aChannel('2', 'a')])).toHaveLength(2);
  });
});

describe('channels they could join', () => {
  test('public, not joined, by name — never a private one or one they are in', () => {
    const list = joinableChannels([
      aChannel('1', 'beta', { state: null }),
      aChannel('2', 'alpha', { state: null }),
      aChannel('3', 'secret', { state: null, type: 'private' }),
      aChannel('4', 'mine'),
    ]);
    expect(names(list)).toEqual(['alpha', 'beta']);
  });
});

describe('people', () => {
  const dm = (id: string, peer: typeof ALICE, minute: number | null): Channel =>
    aChannel(id, null, {
      type: 'direct_message',
      peer,
      lastMessageAt: minute === null ? null : at(minute),
    });

  test('every member once, conversations first by activity, then the rest by name', () => {
    const list = people(someMembers(), [dm('d1', BOB, 2), dm('d2', ALICE, 8)]);
    expect(list.map((p) => p.user.username)).toEqual(['alice', 'bob', 'dogancan']);
    expect(list.map((p) => p.direct?.id ?? null)).toEqual(['d2', 'd1', null]);
  });

  test('the person themselves is one of them, and a note to self is a conversation like any other', () => {
    const list = people(someMembers(), [dm('self', ME, 5)]);
    expect(list[0]?.user.id).toBe(ME.id);
    expect(list[0]?.direct?.id).toBe('self');
  });

  test('two conversations with no activity order by name; a member with one precedes one without', () => {
    const list = people(someMembers(), [dm('d1', BOB, null), dm('d2', ALICE, null)]);
    expect(list.map((p) => p.user.username).slice(0, 2)).toEqual(['alice', 'bob']);
    expect(people(someMembers(), [dm('d1', BOB, null)])[0]?.user.username).toBe('bob');
  });

  test('a conversation with somebody who is no longer a member is kept, once', () => {
    const gone = {
      ...ALICE,
      id: '00000000-0000-4000-8000-0000000000ff',
      username: 'gone',
      displayName: 'Gone',
    };
    const list = people(someMembers().slice(0, 1), [dm('d1', gone, 3)]);
    expect(list.map((p) => p.user.username)).toEqual(['gone', 'dogancan']);
    expect(list.filter((p) => p.user.id === gone.id)).toHaveLength(1);
  });

  test('a direct message the person has not joined, or with no peer, is not a person', () => {
    const stranger = aChannel('d9', null, { type: 'direct_message', peer: ALICE, state: null });
    const nobody = aChannel('d8', null, { type: 'direct_message', peer: null });
    expect(people(someMembers(), [stranger, nobody]).every((p) => p.direct === null)).toBe(true);
  });
});

describe('the open-questions count as shown', () => {
  test('is the number loaded, up to the cap', () => {
    expect(shownQuestionCount(0, false)).toEqual({ count: 0, over: false });
    expect(shownQuestionCount(QUESTION_COUNT_CAP, false)).toEqual({ count: 99, over: false });
  });

  test('says "more than that" when there is another page, or past the cap', () => {
    expect(shownQuestionCount(50, true)).toEqual({ count: 99, over: true });
    expect(shownQuestionCount(100, false)).toEqual({ count: 99, over: true });
  });
});

describe('starred channels (D-132)', () => {
  test('are their own list, by name, and out of the channels', () => {
    const all = [
      aChannel('1', 'zeta', { starred: true }),
      aChannel('2', 'alpha', { starred: true }),
      aChannel('3', 'beta'),
      aChannel('4', 'gamma', { starred: true, state: null }),
    ];
    expect(starredChannels(all).map((c) => c.name)).toEqual(['alpha', 'zeta']);
    expect(joinedChannels(all).map((c) => c.name)).toEqual(['beta']);
  });
});

describe('the order a key steps through (D-132)', () => {
  test('is the sidebar’s: the starred by name, the other channels by activity, then direct messages', async () => {
    const { inSidebarOrder } = await import('../palette/channels');
    const all = [
      aChannel('1', 'zeta', { starred: true, lastMessageAt: '2026-09-09T08:00:00.000Z' }),
      aChannel('2', 'alpha', { starred: true }),
      aChannel('3', 'beta', { lastMessageAt: '2026-09-09T09:00:00.000Z' }),
      aChannel('4', 'gamma'),
    ];
    expect(inSidebarOrder(all).map((c) => c.name)).toEqual(['alpha', 'zeta', 'beta', 'gamma']);
  });
});
