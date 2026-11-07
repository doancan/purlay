import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import {
  FOLLOWED_THREADS_PAGE,
  FollowedThreadsQuery,
  FollowedThreadsPage,
  FollowedThreadUnread,
} from './followed-threads';

const rootId = '0199155c-6200-7b7f-8c11-2a4d3f9e1b70';
const activityAt = '2026-11-07T14:00:00.000Z';

describe('followed conversation contracts', () => {
  test('bounds pages and requires the complete activity/root keyset pair', () => {
    expect(FOLLOWED_THREADS_PAGE).toBe(20);
    for (const query of [
      {},
      { limit: 1 },
      { limit: 100, unreadOnly: true },
      { beforeActivityAt: activityAt, beforeRootId: rootId },
      { beforeActivityAt: '2026-11-07T14:00:00.123456Z', beforeRootId: rootId },
      { limit: 20, unreadOnly: false, beforeActivityAt: activityAt, beforeRootId: rootId },
    ])
      expect(Value.Check(FollowedThreadsQuery, query)).toBe(true);
    for (const query of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { limit: '20' },
      { unreadOnly: 'true' },
      { beforeActivityAt: activityAt },
      { beforeRootId: rootId },
      { beforeActivityAt: 'not a time', beforeRootId: rootId },
      { beforeActivityAt: '2026-02-30T14:00:00.000Z', beforeRootId: rootId },
      { beforeActivityAt: '2026-13-01T14:00:00.000Z', beforeRootId: rootId },
      { beforeActivityAt: '0000-01-01T14:00:00.000Z', beforeRootId: rootId },
      { beforeActivityAt: '+020000-11-07T14:00:00.000Z', beforeRootId: rootId },
      { beforeActivityAt: '2026-11-07T14:00:00.1234567Z', beforeRootId: rootId },
      { beforeActivityAt: '2026-11-07T17:00:00.000+03:00', beforeRootId: rootId },
      { beforeActivityAt: activityAt, beforeRootId: 'other' },
      { userId: rootId },
      { limit: 20, unknown: true },
    ])
      expect(Value.Check(FollowedThreadsQuery, query)).toBe(false);
  });

  test('unknown unread state is distinct from a read conversation and a waiting reply', () => {
    for (const unread of [
      null,
      { count: 0, firstUnreadMessageId: null },
      { count: 1, firstUnreadMessageId: rootId },
      { count: 25, firstUnreadMessageId: rootId },
    ])
      expect(Value.Check(FollowedThreadUnread, unread)).toBe(true);
    for (const unread of [
      { count: 0, firstUnreadMessageId: rootId },
      { count: 1, firstUnreadMessageId: null },
      { count: -1, firstUnreadMessageId: null },
      { count: 1.5, firstUnreadMessageId: rootId },
      { count: 1, firstUnreadMessageId: 'other' },
      { count: 1 },
    ])
      expect(Value.Check(FollowedThreadUnread, unread)).toBe(false);
  });

  test('an empty page and a complete next cursor are valid, while partial cursors are refused', () => {
    expect(Value.Check(FollowedThreadsPage, { data: [], nextCursor: null })).toBe(true);
    expect(Value.Check(FollowedThreadsPage, { data: [], nextCursor: { activityAt, rootId } })).toBe(
      true,
    );
    for (const page of [
      { data: [], nextCursor: { rootId } },
      { data: [], nextCursor: { activityAt } },
      { data: [], nextCursor: { activityAt: 'yesterday', rootId } },
      { data: [{}], nextCursor: null },
      { nextCursor: null },
    ])
      expect(Value.Check(FollowedThreadsPage, page)).toBe(false);
  });

  test('the response accepts the maximum page and refuses a larger one', () => {
    const item = {
      activityAt,
      unread: null,
      root: {
        id: rootId,
        channelId: rootId,
        sender: { id: rootId, username: 'alice', displayName: 'Alice', avatarUrl: null },
        githubEvent: null,
        content: 'Handover',
        editedAt: null,
        deletedAt: null,
        createdAt: activityAt,
        parentId: null,
        thread: { replyCount: 0, lastReplyAt: null, resolvedAt: null, resolvedBy: null },
        reactions: [],
        mentions: [],
        attachments: [],
      },
    };
    expect(
      Value.Check(FollowedThreadsPage, {
        data: Array.from({ length: 100 }, () => item),
        nextCursor: null,
      }),
    ).toBe(true);
    expect(
      Value.Check(FollowedThreadsPage, {
        data: Array.from({ length: 101 }, () => item),
        nextCursor: null,
      }),
    ).toBe(false);
  });
});
