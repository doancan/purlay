/**
 * The feed's rules, as a function: merging by id, days, grouping, the unread marker.
 */
import { describe, expect, test } from 'bun:test';
import type { PendingMessage } from '../../realtime/engine';
import { ALICE, BOB, IDS, ME, aMessage, messageIdAt } from '../../testing/fixtures';
import {
  GROUP_WINDOW_MS,
  buildFeed,
  newestConfirmedId,
  type FeedInput,
  type FeedItem,
} from './feed-model';

const dayLabel = (iso: string): string => iso.slice(0, 10);

const at = (n: number, minutes = 0, day = 9): string =>
  new Date(Date.UTC(2026, 8, day, 8, minutes, n)).toISOString();

const input = (over: Partial<FeedInput> = {}): FeedInput => ({
  messages: [],
  pending: [],
  me: ME,
  markerAfter: undefined,
  dayLabel,
  ...over,
});

const kinds = (items: readonly FeedItem[]): string[] =>
  items.map((item) => (item.kind === 'message' ? item.message.content : item.kind));

const pendingOf = (n: number, over: Partial<PendingMessage> = {}): PendingMessage => ({
  id: messageIdAt(n),
  channelId: IDS.api,
  parentId: null,
  content: `mine ${String(n)}`,
  createdAt: at(n),
  delivery: 'sending',
  reason: null,
  ...over,
});

describe('the order', () => {
  test("is by id, the server's messages and the person's own together", () => {
    const items = buildFeed(
      input({
        messages: [aMessage(1), aMessage(3)],
        pending: [pendingOf(2), pendingOf(4)],
      }),
    );
    expect(kinds(items)).toEqual(['day', 'message 1', 'mine 2', 'message 3', 'mine 4']);
  });

  test("a pending message whose echo has arrived is shown once, as the server's, in its place", () => {
    const items = buildFeed(
      input({
        messages: [aMessage(1), aMessage(2, { content: 'from the server' })],
        pending: [pendingOf(2)],
      }),
    );
    expect(kinds(items)).toEqual(['day', 'message 1', 'from the server']);
    const row = items.find((item) => item.kind === 'message' && item.message.id === messageIdAt(2));
    expect(row).toMatchObject({ delivery: 'sent' });
  });

  test('carries each pending state: sending, failed with its reason, and acknowledged', () => {
    const items = buildFeed(
      input({
        pending: [
          pendingOf(1, { delivery: 'sending' }),
          pendingOf(2, { delivery: 'failed', reason: 'VALIDATION_FAILED' }),
          pendingOf(3, { delivery: 'sent' }),
        ],
      }),
    );
    const rows = items.filter((i) => i.kind === 'message');
    expect(rows.map((r) => [r.delivery, r.failure])).toEqual([
      ['sending', null],
      ['failed', 'VALIDATION_FAILED'],
      ['sent', null],
    ]);
    expect(rows[0]).toMatchObject({ message: { sender: ME, parentId: null } });
  });

  test('an empty channel has no items', () => {
    expect(buildFeed(input())).toEqual([]);
  });
});

describe('days', () => {
  test('a divider opens each day, once, with the label as its identity', () => {
    const items = buildFeed(
      input({
        messages: [
          aMessage(1, { createdAt: at(1, 0, 8) }),
          aMessage(2, { createdAt: at(2, 0, 8) }),
          aMessage(3, { createdAt: at(3, 0, 9) }),
        ],
      }),
    );
    expect(kinds(items)).toEqual(['day', 'message 1', 'message 2', 'day', 'message 3']);
    expect(items.filter((i) => i.kind === 'day').map((i) => i.key)).toEqual([
      'day:2026-09-08',
      'day:2026-09-09',
    ]);
  });
});

describe('grouping', () => {
  const grouped = (items: readonly FeedItem[]): boolean[] =>
    items.flatMap((i) => (i.kind === 'message' ? [i.grouped] : []));

  test('the same author within five minutes is grouped; the first of a run is not', () => {
    const items = buildFeed(
      input({
        messages: [
          aMessage(1, { createdAt: at(0, 0) }),
          aMessage(2, { createdAt: at(0, 4) }),
          aMessage(3, { createdAt: at(0, 8) }),
        ],
      }),
    );
    expect(grouped(items)).toEqual([false, true, true]);
  });

  test('the window is five minutes from the row above, not from the first', () => {
    const items = buildFeed(
      input({
        messages: [
          aMessage(1, { createdAt: new Date(Date.UTC(2026, 8, 9, 8, 0, 0)).toISOString() }),
          aMessage(2, {
            createdAt: new Date(Date.UTC(2026, 8, 9, 8, 0, 0) + GROUP_WINDOW_MS - 1).toISOString(),
          }),
          aMessage(3, {
            createdAt: new Date(Date.UTC(2026, 8, 9, 8, 0, 0) + GROUP_WINDOW_MS * 2).toISOString(),
          }),
        ],
      }),
    );
    expect(grouped(items)).toEqual([false, true, false]);
  });

  test('another author, a new day, the marker and a failed row each start a run', () => {
    const base = { createdAt: at(0, 0) };
    expect(
      grouped(
        buildFeed(input({ messages: [aMessage(1, base), aMessage(2, { ...base, sender: BOB })] })),
      ),
    ).toEqual([false, false]);
    expect(
      grouped(
        buildFeed(
          input({
            messages: [
              aMessage(1, { createdAt: at(0, 59, 8) }),
              aMessage(2, { createdAt: at(0, 0, 9) }),
            ],
          }),
        ),
      ),
    ).toEqual([false, false]);
    expect(
      grouped(
        buildFeed(
          input({ messages: [aMessage(1, base), aMessage(2, base)], markerAfter: messageIdAt(1) }),
        ),
      ),
    ).toEqual([false, false]);
    expect(
      grouped(buildFeed(input({ pending: [pendingOf(1, { delivery: 'failed' }), pendingOf(2)] }))),
    ).toEqual([false, false]);
  });

  test('a message that claims to be from before the row above is not grouped under it', () => {
    const items = buildFeed(
      input({
        messages: [aMessage(1, { createdAt: at(0, 5) }), aMessage(2, { createdAt: at(0, 1) })],
      }),
    );
    expect(grouped(items)).toEqual([false, false]);
  });
});

describe('the unread marker', () => {
  const mixed = [
    aMessage(1),
    aMessage(2, { sender: BOB }),
    aMessage(3, { sender: BOB }),
    aMessage(4, { sender: ALICE }),
  ];

  test('sits above the first message by somebody else past the read position', () => {
    const items = buildFeed(input({ messages: mixed, markerAfter: messageIdAt(1) }));
    expect(kinds(items)).toEqual([
      'day',
      'message 1',
      'marker',
      'message 2',
      'message 3',
      'message 4',
    ]);
  });

  test('is after the day divider when the unread run begins a day', () => {
    const items = buildFeed(
      input({
        messages: [
          aMessage(1, { createdAt: at(0, 0, 8) }),
          aMessage(2, { createdAt: at(0, 0, 9), sender: BOB }),
        ],
        markerAfter: messageIdAt(1),
      }),
    );
    expect(kinds(items)).toEqual(['day', 'message 1', 'day', 'marker', 'message 2']);
  });

  test('skips what the person wrote themselves, and is absent when only they wrote after it', () => {
    const own = [aMessage(1), aMessage(2, { sender: ME }), aMessage(3, { sender: ME })];
    expect(kinds(buildFeed(input({ messages: own, markerAfter: messageIdAt(1) })))).not.toContain(
      'marker',
    );
    const later = [
      aMessage(1, { sender: ME }),
      aMessage(2, { sender: ME }),
      aMessage(3, { sender: BOB }),
    ];
    expect(kinds(buildFeed(input({ messages: later, markerAfter: messageIdAt(1) })))).toEqual([
      'day',
      'message 1',
      'message 2',
      'marker',
      'message 3',
    ]);
  });

  test('"never read" puts it above the oldest message; nothing unread puts it nowhere', () => {
    expect(kinds(buildFeed(input({ messages: mixed, markerAfter: null })))[1]).toBe('marker');
    expect(kinds(buildFeed(input({ messages: mixed, markerAfter: undefined })))).not.toContain(
      'marker',
    );
    expect(kinds(buildFeed(input({ messages: mixed, markerAfter: messageIdAt(9) })))).not.toContain(
      'marker',
    );
  });

  test('a message still being sent is never what the marker names', () => {
    const items = buildFeed(input({ pending: [pendingOf(2)], markerAfter: messageIdAt(1) }));
    expect(kinds(items)).not.toContain('marker');
  });
});

describe('what the server has confirmed', () => {
  test('the newest confirmed id skips what is still on its way and what failed', () => {
    const items = buildFeed(
      input({
        messages: [aMessage(1), aMessage(2)],
        pending: [pendingOf(3, { delivery: 'sending' }), pendingOf(4, { delivery: 'failed' })],
      }),
    );
    expect(newestConfirmedId(items)).toBe(messageIdAt(2));
    expect(newestConfirmedId(buildFeed(input()))).toBeNull();
    expect(
      newestConfirmedId(buildFeed(input({ pending: [pendingOf(3, { delivery: 'sending' })] }))),
    ).toBeNull();
  });
});
