/** What a thread shows: the server's replies and the person's own pending ones, in one order, grouped by the feed's rule. */
import { describe, expect, test } from 'bun:test';
import type { PendingMessage } from '../../realtime/engine';
import { ALICE, BOB, ME, aMessage, messageIdAt } from '../../testing/fixtures';
import { GROUP_WINDOW_MS } from '../channel/feed-model';
import { buildReplies } from './thread-model';

const ROOT = messageIdAt(1);
const reply = (n: number, over: Parameters<typeof aMessage>[1] = {}): ReturnType<typeof aMessage> =>
  aMessage(n, { parentId: ROOT, thread: null, ...over });
const pending = (n: number, over: Partial<PendingMessage> = {}): PendingMessage => ({
  id: messageIdAt(n),
  channelId: aMessage(1).channelId,
  parentId: ROOT,
  content: `mine ${String(n)}`,
  createdAt: aMessage(n).createdAt,
  delivery: 'sending',
  reason: null,
  ...over,
});

describe('the replies of a thread', () => {
  test("are the server's, oldest first, and nothing else when nothing is pending", () => {
    const items = buildReplies({
      replies: [reply(2, { sender: BOB }), reply(3, { sender: ALICE })],
      pending: [],
      me: ME,
    });
    expect(items.map((i) => [i.key, i.delivery, i.grouped])).toEqual([
      [messageIdAt(2), 'sent', false],
      [messageIdAt(3), 'sent', false],
    ]);
    expect(buildReplies({ replies: [], pending: [], me: ME })).toEqual([]);
  });

  test('group under the one above when the same author wrote within five minutes, and not otherwise', () => {
    const at = (seconds: number): string =>
      new Date(Date.UTC(2026, 8, 9, 8, 0, 0) + seconds * 1000).toISOString();
    const items = buildReplies({
      replies: [
        reply(2, { sender: BOB, createdAt: at(0) }),
        reply(3, { sender: BOB, createdAt: at(GROUP_WINDOW_MS / 1000 - 1) }),
        reply(4, { sender: BOB, createdAt: at((GROUP_WINDOW_MS / 1000) * 3) }),
        reply(5, { sender: ALICE, createdAt: at((GROUP_WINDOW_MS / 1000) * 3 + 1) }),
      ],
      pending: [],
      me: ME,
    });
    expect(items.map((i) => i.grouped)).toEqual([false, true, false, false]);
  });

  test('a clock that ran backwards does not group (no negative gap is "within five minutes")', () => {
    const items = buildReplies({
      replies: [
        reply(2, { sender: BOB, createdAt: '2026-09-09T08:10:00.000Z' }),
        reply(3, { sender: BOB, createdAt: '2026-09-09T08:09:00.000Z' }),
      ],
      pending: [],
      me: ME,
    });
    expect(items.map((i) => i.grouped)).toEqual([false, false]);
  });

  test("take the person's own sends in by id, as sending or failed, and show a send once it has an echo", () => {
    const items = buildReplies({
      replies: [reply(2, { sender: BOB }), reply(5, { sender: ME })],
      pending: [
        pending(3),
        pending(4, { delivery: 'failed', reason: 'Too long.' }),
        // The server already has this one: its echo arrived, so it is not shown twice.
        pending(5),
        pending(6, { delivery: 'sent' }),
      ],
      me: ME,
    });
    expect(items.map((i) => [i.key, i.delivery, i.failure])).toEqual([
      [messageIdAt(2), 'sent', null],
      [messageIdAt(3), 'sending', null],
      [messageIdAt(4), 'failed', 'Too long.'],
      [messageIdAt(5), 'sent', null],
      [messageIdAt(6), 'sending', null],
    ]);
    const mine = items.find((i) => i.key === messageIdAt(3));
    expect(mine?.message).toMatchObject({
      parentId: ROOT,
      thread: null,
      sender: ME,
      content: 'mine 3',
    });
  });
});
