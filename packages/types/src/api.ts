/**
 * The HTTP contract, for the endpoints Phase 0 serves.
 *
 * `API.md` is the single source for *which* endpoints exist and what role each
 * needs; this is their shape. A request or response type is added when its
 * endpoint is built — the rule the error codes and the socket frames follow.
 *
 * Authored once as TypeBox schemas, with the TypeScript types derived
 * (`ARCHITECTURE.md` §2).
 */
import {
  Type,
  type Static,
  type TArray,
  type TNull,
  type TObject,
  type TSchema,
  type TString,
  type TUnion,
} from '@sinclair/typebox';
import {
  Channel,
  ChannelState,
  CurrentUser,
  FromClient,
  Membership,
  AttachmentIds,
  Message,
  MessageContent,
  SendContent,
  NotificationLevel,
  Reaction,
  Timestamp,
  User,
  UserRole,
  Uuid,
} from './models';

/**
 * Keyset pagination, always. `nextCursor` is the id to pass back **as whichever
 * cursor you used** — `before` when reading older, `after` when catching up — and
 * it is null when the page is the last one in that direction.
 *
 * `OFFSET` is never accepted: it is O(n) and it shifts under concurrent inserts,
 * which in a live channel is every page (`SCHEMA.md` §6.3, D-8).
 */
export const Page = <T extends TSchema>(
  item: T,
): TObject<{ data: TArray<T>; nextCursor: TUnion<[TString, TNull]> }> =>
  Type.Object({ data: Type.Array(item), nextCursor: Type.Union([Uuid, Type.Null()]) });

/**
 * How long a page is: capped, with a default. One definition — the server's clamp
 * and the contract's schema read it, and `API.md` §1 states it, bound by a test.
 */
export const PAGE_LIMIT = { max: 100, default: 50 } as const;

export const PageQuery = FromClient({
  /** Older than this id. */
  before: Type.Optional(Uuid),
  /** Newer than this id. */
  after: Type.Optional(Uuid),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: PAGE_LIMIT.max, default: PAGE_LIMIT.default }),
  ),
});
export type PageQuery = Static<typeof PageQuery>;

// ── Identity ────────────────────────────────────────────────────────────────

/** `GET /api/me` — the caller, and the workspaces they belong to. */
export const MeResponse = Type.Object({
  user: CurrentUser,
  memberships: Type.Array(Membership),
});
export type MeResponse = Static<typeof MeResponse>;

// ── Workspaces ──────────────────────────────────────────────────────────────

export const CreateWorkspaceRequest = FromClient({
  name: Type.String({ minLength: 1, maxLength: 64, format: 'name' }),
  /** Lowercase, and an identifier rather than prose — hence `COLLATE "C"` (D-40). */
  slug: Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z0-9][a-z0-9-]*$' }),
});
export type CreateWorkspaceRequest = Static<typeof CreateWorkspaceRequest>;

/** A member as the rest of the workspace sees them — never their email address. */
export const WorkspaceMember = Type.Object({
  user: User,
  role: UserRole,
  joinedAt: Type.String({ format: 'date-time' }),
});
export type WorkspaceMember = Static<typeof WorkspaceMember>;

/**
 * `PATCH /api/workspaces/:workspaceId/members/:userId` — a member's new role (`ARCHITECTURE.md`
 * §7.4). Making somebody an owner is transferring ownership, and is an owner's alone.
 */
export const UpdateMemberRoleRequest = FromClient({ role: UserRole });
export type UpdateMemberRoleRequest = Static<typeof UpdateMemberRoleRequest>;

// ── Channels ────────────────────────────────────────────────────────────────

export const CreateChannelRequest = FromClient({
  name: Type.String({ minLength: 1, maxLength: 64, format: 'name' }),
  topic: Type.Optional(Type.String({ format: 'plain-text' })),
  /** Public unless asked: a private channel is seen only by its members (D-104). */
  type: Type.Optional(Type.Union([Type.Literal('public'), Type.Literal('private')])),
});
export type CreateChannelRequest = Static<typeof CreateChannelRequest>;

/**
 * `POST /api/channels/:channelId/members` — a member of the channel brings in somebody from the
 * workspace (D-104). Adding somebody already in it is the same answer.
 */
export const AddChannelMemberRequest = FromClient({ userId: Uuid });
export type AddChannelMemberRequest = Static<typeof AddChannelMemberRequest>;

// ── Messages ────────────────────────────────────────────────────────────────

/**
 * `POST /api/channels/:channelId/messages` — the fallback when the socket is
 * down, running the same service as `MESSAGE_SEND`. The socket is an
 * optimisation, never the only path (`ARCHITECTURE.md` §5.1).
 *
 * **The client supplies the id**, so a retry after a timeout cannot duplicate:
 * re-sending the same id by the same sender in the same channel returns the
 * existing message (D-8). The server validates it first — v7 shape, plausible
 * timestamp — and a collision with somebody else's message is a conflict that
 * discloses nothing (D-33).
 */
export const SendMessageRequest = FromClient({
  id: Uuid,
  /** Empty only when the message carries attachments (D-109 §7). */
  content: SendContent,
  attachmentIds: Type.Optional(AttachmentIds),
  /**
   * Makes this a reply. Must be a root message of the same channel (I-1); a reply
   * to a reply is refused, because depth is a rule of the service and not of any
   * one screen.
   */
  parentId: Type.Optional(Uuid),
});
export type SendMessageRequest = Static<typeof SendMessageRequest>;

/**
 * `PATCH /api/messages/:messageId` — the author replaces the content (D-103). The id and the
 * thread are the message's and do not change; the answer is the message as it now is.
 */
export const EditMessageRequest = FromClient({ content: MessageContent });
export type EditMessageRequest = Static<typeof EditMessageRequest>;

export const MessagePage = Page(Message);
export type MessagePage = Static<typeof MessagePage>;

export const ChannelList = Type.Array(Channel);
export type ChannelList = Static<typeof ChannelList>;

/** The shortest search that a trigram index can answer; shorter would read every visible message. */
export const SEARCH_QUERY_MIN = 3;
export const SEARCH_QUERY_MAX = 200;

/**
 * `GET /api/workspaces/:workspaceId/search` — messages whose words contain `q`, ignoring case, in
 * the channels the caller can see, or in one of them (D-10, D-34, D-105). Newest first, keyset by
 * `before`. `%`, `_` and `\` are themselves, not patterns.
 */
export const SearchQuery = FromClient({
  q: Type.String({
    minLength: SEARCH_QUERY_MIN,
    maxLength: SEARCH_QUERY_MAX,
    format: 'plain-text',
  }),
  channelId: Type.Optional(Uuid),
  before: Type.Optional(Uuid),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: PAGE_LIMIT.max, default: PAGE_LIMIT.default }),
  ),
});
export type SearchQuery = Static<typeof SearchQuery>;

export const SearchPage = Page(Message);
export type SearchPage = Static<typeof SearchPage>;

/** `GET /api/messages/:messageId/thread` — replies, keyset, **oldest first**. */
export const ThreadPage = Page(Message);
export type ThreadPage = Static<typeof ThreadPage>;

/**
 * `GET /api/workspaces/:workspaceId/unresolved` — the open-questions view: roots
 * with at least one reply and no resolution, newest first, from channels the
 * caller can see and no others (D-34).
 */
export const UnresolvedPage = Page(Message);
export type UnresolvedPage = Static<typeof UnresolvedPage>;

/**
 * `PUT /api/channels/:channelId/read` — the newest message the person has seen.
 * Never moves the position backwards, and a message that is not in this channel is
 * refused (I-3). The answer is the new state, so the client does not recompute it.
 */
export const ReadChannelRequest = FromClient({ lastReadMessageId: Uuid });
export type ReadChannelRequest = Static<typeof ReadChannelRequest>;
export const ReadChannelResponse = ChannelState;
export type ReadChannelResponse = Static<typeof ReadChannelResponse>;

/** `PUT`/`DELETE /api/messages/:messageId/reactions/:emoji` — idempotent; answers the message's reactions. */
export const ReactionsResponse = Type.Object({ reactions: Type.Array(Reaction) });
export type ReactionsResponse = Static<typeof ReactionsResponse>;

/** `POST /api/workspaces/:workspaceId/dms` — the same pair gets the same channel (I-5). */
export const CreateDirectMessageRequest = FromClient({ userId: Uuid });
export type CreateDirectMessageRequest = Static<typeof CreateDirectMessageRequest>;

/** `GET /api/workspaces/:workspaceId/members` — who can be messaged, mentioned and counted. */
export const WorkspaceMemberList = Type.Array(WorkspaceMember);
export type WorkspaceMemberList = Static<typeof WorkspaceMemberList>;

/**
 * Why a person is told about a message (D-99 §1, D-29): named in it, sent it directly, answered in a
 * thread they are part of, or their question was resolved. The database's `notification_type`.
 */
export const NotificationType = Type.Union([
  Type.Literal('mention'),
  Type.Literal('direct_message'),
  Type.Literal('thread_reply'),
  Type.Literal('thread_resolved'),
  /** A member at `notification_level = 'all'` is told of every message by somebody else (D-107). */
  Type.Literal('channel_message'),
]);
export type NotificationType = Static<typeof NotificationType>;

/** `PUT /api/channels/:channelId/notification-level` — the caller's own membership (D-107). */
export const SetNotificationLevelRequest = FromClient({ level: NotificationLevel });
export type SetNotificationLevelRequest = Static<typeof SetNotificationLevelRequest>;

/** One thing waiting for the caller in the inbox, with the message it is about (D-106). */
export const Notification = Type.Object({
  id: Uuid,
  type: NotificationType,
  channelId: Uuid,
  message: Message,
  createdAt: Timestamp,
  readAt: Type.Union([Timestamp, Type.Null()]),
});
export type Notification = Static<typeof Notification>;

/**
 * `GET /api/notifications` — one workspace's inbox, newest first (D-106). `before` is the id of the
 * last notification of the previous page; there is no `after`, because new ones arrive at the top.
 */
export const NotificationQuery = FromClient({
  workspaceId: Uuid,
  unreadOnly: Type.Optional(Type.Boolean()),
  before: Type.Optional(Uuid),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: PAGE_LIMIT.max, default: PAGE_LIMIT.default }),
  ),
});
export type NotificationQuery = Static<typeof NotificationQuery>;
export const NotificationPage = Page(Notification);
export type NotificationPage = Static<typeof NotificationPage>;

/** `GET /api/workspaces/:workspaceId/audit` — newest first, keyset by `before` (D-26, #70). */
export const AuditQuery = FromClient({
  before: Type.Optional(Uuid),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: PAGE_LIMIT.max, default: PAGE_LIMIT.default }),
  ),
});
export type AuditQuery = Static<typeof AuditQuery>;

/**
 * One administrative action: who, what, to whom, and for a change from what to what. Never anything
 * a person wrote. The actor is null once they were erased (D-27).
 */
export const AuditEntry = Type.Object({
  id: Uuid,
  actor: Type.Union([User, Type.Null()]),
  action: Type.String({ minLength: 1, maxLength: 64 }),
  targetType: Type.String({ minLength: 1, maxLength: 32 }),
  targetId: Type.Union([Uuid, Type.Null()]),
  metadata: Type.Record(Type.String(), Type.String()),
  createdAt: Timestamp,
});
export type AuditEntry = Static<typeof AuditEntry>;
export const AuditPage = Page(AuditEntry);
export type AuditPage = Static<typeof AuditPage>;

/**
 * `PUT /api/notifications/read` — these, by id; or everything in a workspace, up to and including
 * `before` when given, so what arrived after the person looked is not read for them (D-106).
 */
export const ReadNotificationsRequest = Type.Union([
  FromClient({ ids: Type.Array(Uuid, { minItems: 1, maxItems: PAGE_LIMIT.max }) }),
  FromClient({ workspaceId: Uuid, before: Type.Optional(Uuid) }),
]);
export type ReadNotificationsRequest = Static<typeof ReadNotificationsRequest>;

/** The longest Deep Work may be set for at once: it ends by itself, so it cannot be forgotten on (D-108). */
export const DEEP_WORK_MAX_HOURS = 24;

/**
 * `PUT /api/workspaces/:workspaceId/deep-work` — start it, until an instant within
 * `DEEP_WORK_MAX_HOURS`, or end it (D-108). Whether `until` is in that window is the server's to say:
 * it is a question about the clock.
 */
export const SetDeepWorkRequest = Type.Union([
  FromClient({ active: Type.Literal(true), until: Timestamp }),
  FromClient({ active: Type.Literal(false) }),
]);
export type SetDeepWorkRequest = Static<typeof SetDeepWorkRequest>;
export const DeepWorkResponse = Type.Object({ until: Type.Union([Timestamp, Type.Null()]) });
export type DeepWorkResponse = Static<typeof DeepWorkResponse>;

/**
 * `POST /api/workspaces/:workspaceId/uploads?id=&name=` — the body is the file's bytes (D-109 §3).
 * `id` is the client's UUIDv7 for the attachment; `name` its file name, with no control or
 * bidirectional-override characters.
 */
export const UploadQuery = FromClient({
  id: Uuid,
  name: Type.String({ minLength: 1, maxLength: 255, format: 'name' }),
});
export type UploadQuery = Static<typeof UploadQuery>;

/** How many unattached uploads one person may hold in a workspace (D-109 §5). */
export const PENDING_UPLOADS_MAX = 20;
