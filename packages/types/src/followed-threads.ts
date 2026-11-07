/** Workspace-wide followed conversations; listing never moves a receipt or follow preference. */
import { Type, type Static } from '@sinclair/typebox';
import { FromClient, Message, Uuid } from './models';
import { PAGE_LIMIT } from './api';

export const FOLLOWED_THREADS_PAGE = 20;

/** A server-issued activity key preserves PostgreSQL microseconds, with a UUID tie-breaker. */
const ActivityAt = Type.String({ format: 'cursor-time' });
export const FollowedThreadsCursor = Type.Object({ activityAt: ActivityAt, rootId: Uuid });
export type FollowedThreadsCursor = Static<typeof FollowedThreadsCursor>;

const options = {
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: PAGE_LIMIT.max, default: FOLLOWED_THREADS_PAGE }),
  ),
  unreadOnly: Type.Optional(Type.Boolean()),
};
export const FollowedThreadsQuery = Type.Union([
  FromClient(options),
  FromClient({ ...options, beforeActivityAt: ActivityAt, beforeRootId: Uuid }),
]);
export type FollowedThreadsQuery = Static<typeof FollowedThreadsQuery>;

/** Null means no membership receipt exists, not that every reply has been read. */
export const FollowedThreadUnread = Type.Union([
  Type.Null(),
  Type.Object({ count: Type.Literal(0), firstUnreadMessageId: Type.Null() }),
  Type.Object({ count: Type.Integer({ minimum: 1 }), firstUnreadMessageId: Uuid }),
]);
export type FollowedThreadUnread = Static<typeof FollowedThreadUnread>;

export const FollowedThread = Type.Object({
  root: Message,
  activityAt: ActivityAt,
  unread: FollowedThreadUnread,
});
export type FollowedThread = Static<typeof FollowedThread>;

export const FollowedThreadsPage = Type.Object({
  data: Type.Array(FollowedThread, { maxItems: PAGE_LIMIT.max }),
  nextCursor: Type.Union([FollowedThreadsCursor, Type.Null()]),
});
export type FollowedThreadsPage = Static<typeof FollowedThreadsPage>;
