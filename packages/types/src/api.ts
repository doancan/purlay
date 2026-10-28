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
  Attachment,
  FromClient,
  GITHUB_REPOSITORY_PATTERN,
  GitHubLink,
  IncidentSeverity,
  IncidentStatus,
  Membership,
  OpenIncidentStatus,
  PROFILE_STATUS_MAX,
  PROFILE_TITLE_MAX,
  Profile,
  AttachmentIds,
  Message,
  MessageContent,
  SendContent,
  NotificationLevel,
  Reaction,
  Timestamp,
  User,
  Workspace,
  UserRole,
  Uuid,
} from './models';
import { PresenceChange } from './events';
import { REPLAY_OVERLAP_MS } from './message-id';

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
  /** The caller's own profile, for the dialog that changes it (D-131). */
  profile: Profile,
  memberships: Type.Array(Membership),
  /**
   * Whether this server would let the caller make a workspace (D-155): whom the server's setting
   * names (D-179 §6; first seeded from `WORKSPACE_CREATORS`), or, by default, only the first person
   * to sign in while there is none. The client
   * offers the form only where it would be accepted.
   */
  mayCreateWorkspace: Type.Boolean(),
  /**
   * Whether the caller is this server's administrator (`users.is_server_admin`, D-179 §4.8): the
   * client draws Settings → Server only for them. Read only; what it opens is the server's to refuse.
   */
  isServerAdmin: Type.Boolean(),
});
export type MeResponse = Static<typeof MeResponse>;

// ── Workspaces ──────────────────────────────────────────────────────────────

/** The longest workspace name, as `workspaces.name` holds it (`VARCHAR(64)`, migration 0003). */
export const WORKSPACE_NAME_MAX = 64;

export const CreateWorkspaceRequest = FromClient({
  name: Type.String({ minLength: 1, maxLength: WORKSPACE_NAME_MAX, format: 'name' }),
  /** Lowercase, and an identifier rather than prose — hence `COLLATE "C"` (D-40). */
  slug: Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z0-9][a-z0-9-]*$' }),
});
export type CreateWorkspaceRequest = Static<typeof CreateWorkspaceRequest>;

/**
 * The channel a new workspace starts with, its creator in it, so the first screen is a place to talk
 * and an invited person has somewhere to go (D-174). A name, as every channel's is — renamed, left or
 * archived like any other; nothing marks it afterwards.
 */
export const DEFAULT_CHANNEL_NAME = 'general';

/**
 * `PATCH /api/workspaces/:workspaceId` — an owner or an admin renames the workspace (D-124). The name
 * only: the slug is its address, in every link already pasted, and does not move (D-124).
 */
export const UpdateWorkspaceRequest = FromClient({
  name: Type.String({ minLength: 1, maxLength: WORKSPACE_NAME_MAX, format: 'name' }),
});
export type UpdateWorkspaceRequest = Static<typeof UpdateWorkspaceRequest>;

/** The shortest window an owner may keep history for — the database's `retention_days_sane` (D-27). */
export const RETENTION_DAYS_MIN = 30;
/** The longest: a hundred years, past which a number is a typo, not a policy (D-139 §4). */
export const RETENTION_DAYS_MAX = 36_500;

/** Whole days of history kept, or `null` for everything — the default, and the tenet (D-2, D-27). */
const RetentionDays = Type.Union([
  Type.Integer({ minimum: RETENTION_DAYS_MIN, maximum: RETENTION_DAYS_MAX }),
  Type.Null(),
]);

/**
 * `GET` and `PUT /api/workspaces/:workspaceId/retention` — an owner's to read and to set (D-139 §4).
 * Its own route: the `Workspace` shape is shown to people not yet in it, in an invitation's preview.
 */
export const RetentionSetting = Type.Object({ retentionDays: RetentionDays });
export type RetentionSetting = Static<typeof RetentionSetting>;
export const SetRetentionRequest = FromClient({ retentionDays: RetentionDays });
export type SetRetentionRequest = Static<typeof SetRetentionRequest>;

/**
 * `GET /api/workspaces/:workspaceId/storage` — how much of its quota the workspace's files take, an
 * owner's to read (D-173). `usedBytes` is what the upload check counts — the files sent and the uploads
 * still waiting to be — so the meter and a refused upload never disagree. The quota is the operator's
 * to set (`bun run storage:quota`), never the owner's: it is the operator's disk.
 */
export const StorageUsage = Type.Object({
  usedBytes: Type.Integer({ minimum: 0 }),
  quotaBytes: Type.Integer({ minimum: 0 }),
});
export type StorageUsage = Static<typeof StorageUsage>;

/** A member as the rest of the workspace sees them — never their email address. */
export const WorkspaceMember = Type.Object({
  user: User,
  role: UserRole,
  joinedAt: Type.String({ format: 'date-time' }),
  /** What they say about themselves: shown in a conversation with them and where people are picked. */
  profile: Profile,
});
export type WorkspaceMember = Static<typeof WorkspaceMember>;

/**
 * `PATCH /api/workspaces/:workspaceId/members/:userId` — a member's new role (`ARCHITECTURE.md`
 * §7.4). Making somebody an owner is transferring ownership, and is an owner's alone.
 */
export const UpdateMemberRoleRequest = FromClient({ role: UserRole });
export type UpdateMemberRoleRequest = Static<typeof UpdateMemberRoleRequest>;

// ── Channels ────────────────────────────────────────────────────────────────

/** A channel's name, as it is created and as it is renamed: one rule for both. */
const ChannelName = Type.String({ minLength: 1, maxLength: 64, format: 'name' });
/** What a channel is for, in a line. */
const ChannelTopic = Type.String({ format: 'plain-text' });

export const CreateChannelRequest = FromClient({
  name: ChannelName,
  topic: Type.Optional(ChannelTopic),
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

/**
 * `PATCH /api/channels/:channelId` — a member of the channel renames it or sets what it is for
 * (D-123). Each field is optional and only what is sent changes; a `null` topic clears it. The answer
 * is the channel as the caller now sees it, and the room hears `CHANNEL_UPDATED`.
 */
export const UpdateChannelRequest = FromClient({
  name: Type.Optional(ChannelName),
  topic: Type.Optional(Type.Union([ChannelTopic, Type.Null()])),
});
export type UpdateChannelRequest = Static<typeof UpdateChannelRequest>;

/** Somebody in a channel, and since when. */
export const ChannelMember = Type.Object({
  user: User,
  joinedAt: Type.String({ format: 'date-time' }),
});
export type ChannelMember = Static<typeof ChannelMember>;

/**
 * `GET /api/channels/:channelId/members` — who is in it, first to join first. Not paged, as the
 * workspace's own list is not: a channel's members are some of the workspace's (D-123).
 */
export const ChannelMemberList = Type.Array(ChannelMember);
export type ChannelMemberList = Static<typeof ChannelMemberList>;

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

/**
 * How far behind the watermark a client holds, a read of the changes reaches back (D-194): the time a write may
 * take between stamping a row and committing it, which is the only way a change can be stamped before a reader's
 * watermark and be missing from that reader's answer. A client discards what it already holds by id and version,
 * as it does for a replay (D-65).
 */
export const CHANGES_OVERLAP_MS = REPLAY_OVERLAP_MS;

/** An opaque cursor into the changes of a channel: where the page ended and the watermark the walk began at. */
export const CHANGES_CURSOR_PATTERN =
  '^[0-9]{13}\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.[0-9]{13}$';

/**
 * `GET /api/channels/:channelId/changes` (D-194): with neither parameter, only the watermark; with `since` — the
 * `asOf` the client holds — the first page of what changed after it; with `after`, the next. They are not given
 * together: `after` carries the watermark of the walk it continues.
 */
export const ChangesQuery = FromClient({
  since: Type.Optional(Timestamp),
  after: Type.Optional(Type.String({ pattern: CHANGES_CURSOR_PATTERN })),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: PAGE_LIMIT.max, default: PAGE_LIMIT.default }),
  ),
});
export type ChangesQuery = Static<typeof ChangesQuery>;

/**
 * The messages a channel's change touched, oldest change first — a root or a reply, a deleted one as its tombstone
 * — each as it now stands. `asOf` is the server's clock when the walk began and is the same on every page of it: a
 * client keeps it, and asks `since` it, once the last page (`nextCursor` null) has been read.
 */
export const ChangePage = Type.Object({
  data: Type.Array(Message),
  nextCursor: Type.Union([Type.String({ pattern: CHANGES_CURSOR_PATTERN }), Type.Null()]),
  asOf: Timestamp,
});
export type ChangePage = Static<typeof ChangePage>;

/** How many roots a window around a message holds on each side of the one it is around (D-149). */
export const MESSAGE_WINDOW_SIDE = 25;

/**
 * `GET /api/messages/:messageId/around` — a channel's feed around one message: what a link to a
 * message opens (D-149).
 *
 * `target` is the message the link names — a root, or a reply, whose thread then opens. `data` is
 * the root it lives under (itself, or its thread's root) with up to `MESSAGE_WINDOW_SIDE` roots on
 * each side, **newest first** as every feed page is. The two cursors are the keyset cursors a feed
 * already reads with (D-8): `olderCursor` continues as `before`, `newerCursor` as `after`, and each
 * is null once that end of the channel is in the window.
 */
export const MessageWindow = Type.Object({
  target: Message,
  data: Type.Array(Message),
  olderCursor: Type.Union([Uuid, Type.Null()]),
  newerCursor: Type.Union([Uuid, Type.Null()]),
});
export type MessageWindow = Static<typeof MessageWindow>;

export const ChannelList = Type.Array(Channel);
export type ChannelList = Static<typeof ChannelList>;

/** The shortest search that a trigram index can answer; shorter would read every visible message. */
export const SEARCH_QUERY_MIN = 3;
export const SEARCH_QUERY_MAX = 200;

/**
 * `GET /api/workspaces/:workspaceId/search` — messages whose words contain `q`, ignoring case, in
 * the channels the caller can see, or in one of them, from anybody or from one person (D-10, D-34,
 * D-105, D-166). Newest first, keyset by `before`. `%`, `_` and `\` are themselves, not patterns.
 */
export const SearchQuery = FromClient({
  q: Type.String({
    minLength: SEARCH_QUERY_MIN,
    maxLength: SEARCH_QUERY_MAX,
    format: 'plain-text',
  }),
  channelId: Type.Optional(Uuid),
  /**
   * Only what this person wrote (D-166). A filter, not a resource: somebody who never wrote in the
   * caller's visible channels — another workspace's, or nobody at all — is an empty page, not a 404.
   */
  senderId: Type.Optional(Uuid),
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
 * Its query: a page, and optionally one channel's questions alone — what a channel's header counts
 * and its narrowed view lists. A channel the caller cannot see is `404 CHANNEL_NOT_FOUND`, as search
 * answers it: narrowing never widens the visible set (D-34).
 */
export const UnresolvedQuery = FromClient({
  channelId: Type.Optional(Uuid),
  before: Type.Optional(Uuid),
  after: Type.Optional(Uuid),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: PAGE_LIMIT.max, default: PAGE_LIMIT.default }),
  ),
});
export type UnresolvedQuery = Static<typeof UnresolvedQuery>;

/**
 * `PUT /api/channels/:channelId/read` — the newest message the person has seen.
 * Never moves the position backwards, and a message that is not in this channel is
 * refused (I-3). The answer is the new state, so the client does not recompute it.
 */
export const ReadChannelRequest = FromClient({ lastReadMessageId: Uuid });
export type ReadChannelRequest = Static<typeof ReadChannelRequest>;
export const ReadChannelResponse = ChannelState;
export type ReadChannelResponse = Static<typeof ReadChannelResponse>;

/**
 * `PUT /api/messages/:messageId/thread/read` — the newest reply the person has seen in the thread
 * of this root. A reply is read here, not by the channel's read position (D-147): the caller's
 * notifications for this thread's replies up to and including it are read. Nothing is stored but
 * that, so a bound behind an earlier one changes nothing; the answer is `204`, and the channel's new
 * state goes to the caller's devices as `CHANNEL_STATE`.
 */
export const ReadThreadRequest = FromClient({ lastReadMessageId: Uuid });
export type ReadThreadRequest = Static<typeof ReadThreadRequest>;

/**
 * `GET` and `PUT /api/messages/:messageId/follow` — whether the caller is told of new replies in the
 * thread of this root (D-161). Without a choice of their own, they follow a thread they started or
 * have answered (D-29); a choice, either way, is kept until they make another — replying again does
 * not take it back. A mention is addressed to them and is told whatever they chose.
 */
export const ThreadFollow = Type.Object({ following: Type.Boolean() });
export type ThreadFollow = Static<typeof ThreadFollow>;

/** `PUT /api/messages/:messageId/follow` — the caller's own choice; the answer is `ThreadFollow`. */
export const SetThreadFollowRequest = FromClient({ following: Type.Boolean() });
export type SetThreadFollowRequest = Static<typeof SetThreadFollowRequest>;

/** `PUT`/`DELETE /api/messages/:messageId/reactions/:emoji` — idempotent; answers the message's reactions. */
export const ReactionsResponse = Type.Object({ reactions: Type.Array(Reaction) });
export type ReactionsResponse = Static<typeof ReactionsResponse>;

/**
 * The most people a conversation has, the caller counted (D-127): past it, it is a channel — with a
 * name, settings and a topic.
 */
export const CONVERSATION_PEOPLE_MAX = 10;

/**
 * `POST /api/workspaces/:workspaceId/conversations` — the people besides the caller. The same set
 * opens the same conversation, whatever the order (I-5, D-127).
 */
export const OpenConversationRequest = FromClient({
  userIds: Type.Array(Uuid, {
    minItems: 1,
    maxItems: CONVERSATION_PEOPLE_MAX - 1,
    uniqueItems: true,
  }),
});
export type OpenConversationRequest = Static<typeof OpenConversationRequest>;

/** `POST /api/workspaces/:workspaceId/dms` — the same pair gets the same channel (I-5). */
export const CreateDirectMessageRequest = FromClient({ userId: Uuid });
export type CreateDirectMessageRequest = Static<typeof CreateDirectMessageRequest>;

/** `GET /api/workspaces/:workspaceId/members` — who can be messaged, mentioned and counted. */
export const WorkspaceMemberList = Type.Array(WorkspaceMember);
export type WorkspaceMemberList = Static<typeof WorkspaceMemberList>;

/** `GET /api/workspaces`: the caller's memberships, a workspace and the role in it each. */
export const MembershipList = Type.Array(Membership);
export type MembershipList = Static<typeof MembershipList>;

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
  Type.Literal('reminder'),
]);
export type NotificationType = Static<typeof NotificationType>;

// The wire value is a single CSV string, not an array that needs an implicit query serializer.
// Derive the vocabulary, bound and duplicate checks from the one owned notification enum.
const notificationTypes = NotificationType.anyOf.map((type) => type.const);
const notificationTypePattern = `(?:${notificationTypes.join('|')})`;
const noRepeatedNotificationTypes = notificationTypes
  .map((type) => `(?!.*(?:^|,)${type}(?:,[^,]+)*,${type}(?:,|$))`)
  .join('');
const notificationTypeListPattern = `${notificationTypePattern}(?:,${notificationTypePattern}){0,${String(notificationTypes.length - 1)}}`;
export const NotificationTypesFilter = Type.String({
  minLength: 1,
  maxLength: notificationTypes.join(',').length,
  // Absolute end: `$` alone would also accept a final newline.
  pattern: String.raw`^${noRepeatedNotificationTypes}${notificationTypeListPattern}(?![\s\S])`,
  description:
    'One CSV query value containing distinct NotificationType values; case-sensitive, no whitespace or empty items. Omit to include every type.',
});
export type NotificationTypesFilter = Static<typeof NotificationTypesFilter>;

/**
 * The reasons that make a message one that *needs* the person (D-99 §1, D-107): what the mention
 * badge counts, the tab's title adds up, a push is sent for (D-126) and an open tab in the background
 * is told of (D-148). A resolution is told and not counted — it is not a message. One list, read by
 * the server's send, read and delete, and by the client: "needs you" is not defined twice.
 */
export const NEEDS_YOU = [
  'mention',
  'direct_message',
  'thread_reply',
  'channel_message',
] as const satisfies readonly NotificationType[];

/** `PUT /api/channels/:channelId/notification-level` — the caller's own membership (D-107). */
export const SetNotificationLevelRequest = FromClient({ level: NotificationLevel });
export type SetNotificationLevelRequest = Static<typeof SetNotificationLevelRequest>;

/** How much of a thread's root the inbox quotes to name it (D-162): one line, not the message. */
export const THREAD_EXCERPT_MAX = 120;

/**
 * The thread a reply belongs to, in brief (D-162): enough to name it and to say whose it is, so the
 * inbox can gather one thread's replies under its first line. `excerpt` is the root's text, plain and
 * on one line, at most `THREAD_EXCERPT_MAX` characters — null when there is nothing to quote: the root
 * was deleted (D-9), or it says nothing in words. `authorId` is null for a root nobody wrote.
 */
export const NotificationThread = Type.Object({
  rootId: Uuid,
  excerpt: Type.Union([Type.String({ maxLength: THREAD_EXCERPT_MAX }), Type.Null()]),
  authorId: Type.Union([Uuid, Type.Null()]),
});
export type NotificationThread = Static<typeof NotificationThread>;

/**
 * One thing waiting for the caller in the inbox, with the message it is about (D-106) and, when that
 * message is a reply, its thread in brief (D-162) — null when it is not one.
 */
export const Notification = Type.Object({
  id: Uuid,
  type: NotificationType,
  channelId: Uuid,
  message: Message,
  thread: Type.Union([NotificationThread, Type.Null()]),
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
  types: Type.Optional(NotificationTypesFilter),
  unreadOnly: Type.Optional(Type.Boolean()),
  before: Type.Optional(Uuid),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: PAGE_LIMIT.max, default: PAGE_LIMIT.default }),
  ),
});
export type NotificationQuery = Static<typeof NotificationQuery>;
export const NotificationPage = Page(Notification);
export type NotificationPage = Static<typeof NotificationPage>;

/**
 * `PUT /api/workspaces/:workspaceId/integrations/github` — the workspace's one GitHub token (D-11,
 * D-23): printable characters, no spaces. Sealed at rest, never logged, never returned.
 */
export const SetGitHubTokenRequest = FromClient({
  token: Type.String({ minLength: 1, maxLength: 255, pattern: '^[\\x21-\\x7e]+$' }),
});
export type SetGitHubTokenRequest = Static<typeof SetGitHubTokenRequest>;

/** `GET …/integrations/github` — whether a token is set, and since when. Never the token. */
export const GitHubIntegration = Type.Object({
  configured: Type.Boolean(),
  updatedAt: Type.Union([Timestamp, Type.Null()]),
});
export type GitHubIntegration = Static<typeof GitHubIntegration>;

/** `POST /api/integrations/github/unfurl` — a link, unfurled with the workspace's token (D-23). */
export const UnfurlRequest = FromClient({ workspaceId: Uuid, url: GitHubLink });
export type UnfurlRequest = Static<typeof UnfurlRequest>;

/** A pull request's or an issue's card (`ARCHITECTURE.md` §8.3). */
export const GitHubCardMetadata = Type.Object({
  type: Type.Union([Type.Literal('pr'), Type.Literal('issue')]),
  repo: Type.String({ minLength: 1, maxLength: 200 }),
  number: Type.Integer({ minimum: 1 }),
  title: Type.String({ maxLength: 1024 }),
  state: Type.Union([Type.Literal('open'), Type.Literal('closed'), Type.Literal('merged')]),
  author: Type.Object({ login: Type.String({ maxLength: 100 }), avatarUrl: Type.String() }),
  /** A pull request's checks on its last commit, rolled up; absent for an issue, or with no checks (#423). */
  ciStatus: Type.Optional(
    Type.Union([Type.Literal('success'), Type.Literal('failure'), Type.Literal('pending')]),
  ),
  /** What its reviews decided; absent for an issue, or when nothing is required or given (#423). */
  reviewDecision: Type.Optional(
    Type.Union([
      Type.Literal('approved'),
      Type.Literal('changes_requested'),
      Type.Literal('review_required'),
    ]),
  ),
});
export type GitHubCardMetadata = Static<typeof GitHubCardMetadata>;
/** The endpoint's answer: the card, or none — no token, nothing there, or GitHub did not answer. */
export const UnfurlResponse = Type.Union([GitHubCardMetadata, Type.Null()]);
export type UnfurlResponse = Static<typeof UnfurlResponse>;

/**
 * A list read newest first, older pages by `before`: the audit trail (D-26, #70) and the invitation
 * links (D-115).
 */
export const OlderPageQuery = FromClient({
  before: Type.Optional(Uuid),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: PAGE_LIMIT.max, default: PAGE_LIMIT.default }),
  ),
});
export type OlderPageQuery = Static<typeof OlderPageQuery>;

/**
 * The administrative actions recorded today (D-26), each a stable machine-readable name. The API
 * records only these; a client names each in words. On the wire `action` stays a string: the API and
 * the client are deployed apart, and a client older than an action says it by its name instead of
 * failing the whole trail.
 */
export const AUDIT_ACTIONS = [
  'member.role_changed',
  'member.removed',
  'member.left',
  'member.joined',
  'channel.created',
  'channel.renamed',
  'channel.archived',
  'channel.member_added',
  'channel.member_removed',
  'integration.token_set',
  'integration.token_removed',
  'integration.feed_created',
  'integration.feed_removed',
  'invitation.created',
  'invitation.revoked',
  'message.removed_by_moderator',
  'workspace.renamed',
  'retention.changed',
  'account.erased',
  'content.erased',
  'workspace.export_requested',
  'workspace.exported',
  'retention.purged',
  'storage.quota_changed',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

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

/** The longest external image address the proxy reads (#110); a longer one is not a picture's. */
export const EXTERNAL_IMAGE_URL_MAX = 2048;

/** `GET /api/images?url=` — an image on another server, fetched and re-encoded by the API (#110). */
export const ExternalImageQuery = FromClient({
  url: Type.String({ minLength: 1, maxLength: EXTERNAL_IMAGE_URL_MAX }),
});
export type ExternalImageQuery = Static<typeof ExternalImageQuery>;

/** How long an invitation link lets people in, from when it is made (D-115). */
export const INVITATION_TTL_DAYS = 7;

/**
 * The secret an invitation link carries: 32 random bytes as 64 hex digits, as a session's. It
 * travels in a request's body and a page's fragment, never a path or a query, which are logged.
 */
export const InvitationToken = Type.String({ pattern: '^[0-9a-f]{64}$' });

/** One of a workspace's links as its admins see it — never the token, which is shown once. */
export const Invitation = Type.Object({
  id: Uuid,
  /** Null once the person who made it was erased (D-27). */
  createdBy: Type.Union([User, Type.Null()]),
  createdAt: Timestamp,
  expiresAt: Timestamp,
});
export type Invitation = Static<typeof Invitation>;

/** The languages a sign-in message is written in: the interface's (D-41). */
export const SignInLocale = Type.Union([Type.Literal('en'), Type.Literal('tr')]);

/** The most addresses one request may name (D-179 §5): more is `400`, not a longer wait. */
export const INVITATION_EMAILS_PER_REQUEST = 20;
/** Invitation e-mails one inviter may have sent in a day, whatever the workspace (D-179 §5). */
export const INVITATION_EMAILS_PER_INVITER_PER_DAY = 50;
/** Invitation e-mails one workspace may have sent in a day, whoever asks (D-179 §5). */
export const INVITATION_EMAILS_PER_WORKSPACE_PER_DAY = 200;

/**
 * `POST …/invitations` — a new link, and optionally the addresses to send it to, in the language the
 * letter is written in (the interface's, D-41). No role and no address is bound to the link: it is the
 * same bearer link whoever holds it (D-115, D-179 §5). The body may be empty, as it was.
 */
export const CreateInvitationRequest = FromClient({
  emails: Type.Optional(
    Type.Array(Type.String({ maxLength: 254 }), { maxItems: INVITATION_EMAILS_PER_REQUEST }),
  ),
  locale: Type.Optional(SignInLocale),
});
export type CreateInvitationRequest = Static<typeof CreateInvitationRequest>;

/**
 * What became of one address. `queued` is all the server can honestly say: the letter is handed to the
 * mail server *after* the answer, so neither delivery nor even the hand-over has happened yet — a
 * failure then is logged, not told. The others are refusals made before anything was queued.
 */
export const InvitationMailOutcome = Type.Union([
  Type.Literal('queued'),
  Type.Literal('invalid'),
  Type.Literal('inviter_limit'),
  Type.Literal('workspace_limit'),
  Type.Literal('unavailable'),
]);
export type InvitationMailOutcome = Static<typeof InvitationMailOutcome>;

export const InvitationMailResult = Type.Object({
  /** As the inviter typed it, trimmed. */
  address: Type.String(),
  outcome: InvitationMailOutcome,
});
export type InvitationMailResult = Static<typeof InvitationMailResult>;

/**
 * `POST …/invitations` — the link just made, with its token, this once. `mail` is there when addresses
 * were named: one entry for each, in order, the repeats of an address (any case) dropped.
 */
export const CreatedInvitation = Type.Object({
  invitation: Invitation,
  token: InvitationToken,
  mail: Type.Optional(Type.Array(InvitationMailResult)),
});
export type CreatedInvitation = Static<typeof CreatedInvitation>;

/** `GET …/invitations` — the links that still let people in, newest first. */
export const InvitationPage = Page(Invitation);
export type InvitationPage = Static<typeof InvitationPage>;

/** `POST /api/invitations/preview` and `…/accept` — the link's token, in the body. */
export const InvitationTokenRequest = FromClient({ token: InvitationToken });
export type InvitationTokenRequest = Static<typeof InvitationTokenRequest>;

/**
 * `POST /api/invitations/passport` — a newcomer's pass to make an account on an invite-only server by
 * this link (D-179 §5). With `email`, the pass is for that address and the mail's link; without, it is
 * for the browser asking, which GitHub's return will be told apart by (a cookie). The link in `token`.
 */
export const InvitationPassportRequest = FromClient({
  token: InvitationToken,
  email: Type.Optional(Type.String({ format: 'email', maxLength: 254 })),
});
export type InvitationPassportRequest = Static<typeof InvitationPassportRequest>;

/** What a link opens, shown before the person joins. */
export const InvitationPreview = Type.Object({
  workspace: Workspace,
  expiresAt: Timestamp,
  /** Already in it: the page offers to open the workspace rather than to join. */
  member: Type.Boolean(),
});
export type InvitationPreview = Static<typeof InvitationPreview>;

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

// ── Web Push (#78, D-126) ───────────────────────────────────────────────────

/** A push key or secret as the browser hands it over: base64url, no padding. */
const Base64Url = (bytes: number): ReturnType<typeof Type.String> =>
  Type.String({ pattern: `^[A-Za-z0-9_-]{${String(Math.ceil((bytes * 4) / 3))}}$` });

/**
 * `GET /api/push/key` — the application server's public key a browser subscribes with, or `null`
 * where the operator has push off: an answer, not an error, since every signed-in page asks.
 */
export const PushKeyResponse = Type.Object({ publicKey: Type.Union([Base64Url(65), Type.Null()]) });
export type PushKeyResponse = Static<typeof PushKeyResponse>;

/** The languages a device's notifications are written in — the interface's own (D-41). */
export const PushLocale = Type.Union([Type.Literal('en'), Type.Literal('tr')]);
export type PushLocale = Static<typeof PushLocale>;

/**
 * `POST /api/push/subscriptions` — this device, as its browser's `PushSubscription` describes it,
 * and the language it is told in. The endpoint is the push service's address for this browser:
 * `https:` only, and bounded.
 */
export const PushSubscribeRequest = FromClient({
  endpoint: Type.String({ pattern: '^https://', maxLength: 2048 }),
  keys: FromClient({ p256dh: Base64Url(65), auth: Base64Url(16) }),
  locale: PushLocale,
});
export type PushSubscribeRequest = Static<typeof PushSubscribeRequest>;

/**
 * `POST /api/me/erase` — the person erases their own account (D-27 §2, D-139 §5): their username, typed,
 * so a slip of the hand erases nothing. From a session signed in within `ERASURE_SIGN_IN_MINUTES`.
 */
export const EraseAccountRequest = FromClient({ confirm: Type.String({ maxLength: 64 }) });
export type EraseAccountRequest = Static<typeof EraseAccountRequest>;

/** How recent a sign-in erasing an account needs (D-139 §5). */
export const ERASURE_SIGN_IN_MINUTES = 15;

/** `PUT /api/me/locale` — the language the server writes this person's notifications in (D-41). */
export const SetLocaleRequest = FromClient({ locale: PushLocale });
export type SetLocaleRequest = Static<typeof SetLocaleRequest>;

/** `POST /api/push/subscriptions/remove` — this device stops being told. */
export const PushUnsubscribeRequest = FromClient({
  endpoint: Type.String({ pattern: '^https://', maxLength: 2048 }),
});
export type PushUnsubscribeRequest = Static<typeof PushUnsubscribeRequest>;

/**
 * A path of this site. `//host`, `/\\host` and a slash after a tab or a newline are other sites'
 * addresses spelled like one, so a second slash or a backslash after the first, any backslash, and
 * control characters are refused.
 */
const SITE_PATH = '^/(?![/\\\\])[^\\\\\\u0000-\\u001f\\u007f]*$';

/**
 * What a push carries, encrypted for the device (RFC 8291) and read by its service worker: who and
 * where, never what was said (D-126), and the address to open. `tag` folds the notifications of one
 * channel into one on the device.
 */
export const PushPayload = Type.Object({
  title: Type.String({ maxLength: 200 }),
  body: Type.String({ maxLength: 200 }),
  url: Type.String({ pattern: SITE_PATH, maxLength: 512 }),
  tag: Type.String({ maxLength: 100 }),
});
export type PushPayload = Static<typeof PushPayload>;

/**
 * What the push worker tells an open tab when its notification is clicked: go to this path. The
 * worker cannot navigate a tab it does not control, and the tab's own router keeps its state.
 */
export const PushOpenMessage = Type.Object({
  kind: Type.Literal('push-open'),
  url: Type.String({ pattern: SITE_PATH, maxLength: 512 }),
});
export type PushOpenMessage = Static<typeof PushOpenMessage>;

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

// ── Saved items (#484, D-128) ──────────────────────────────────────────────

/** How many messages a person keeps saved in a workspace — what the Saved view and its ids hold. */
export const SAVED_MAX = 1000;

/** Where a saved message is in the person's own work: kept, put away, or done (D-128). */
export const SavedState = Type.Union([
  Type.Literal('in_progress'),
  Type.Literal('archived'),
  Type.Literal('completed'),
]);
export type SavedState = Static<typeof SavedState>;

/**
 * `PUT /api/messages/:messageId/saved` — save it, or move it to a state. Without `state` a new save
 * is `in_progress` and an existing one keeps the state it has: saving again never undoes "done".
 */
/** Durable drafts delivered by the server at the chosen time, independently of a client session. */
export const MESSAGE_REMINDERS_MAX = 100;
export const SetMessageReminderRequest = FromClient({ remindAt: Timestamp });
export type SetMessageReminderRequest = Static<typeof SetMessageReminderRequest>;
export const MessageReminder = Type.Object({
  id: Uuid,
  message: Message,
  remindAt: Timestamp,
  createdAt: Timestamp,
});
export type MessageReminder = Static<typeof MessageReminder>;
export const MessageReminderList = Type.Array(MessageReminder, { maxItems: MESSAGE_REMINDERS_MAX });
export type MessageReminderList = Static<typeof MessageReminderList>;

export const SCHEDULED_MESSAGES_MAX = 100;
export const SCHEDULE_AHEAD_MAX_DAYS = 365;
export const ScheduledMessageState = Type.Union([
  Type.Literal('pending'),
  Type.Literal('sent'),
  Type.Literal('failed'),
]);
export type ScheduledMessageState = Static<typeof ScheduledMessageState>;
export const ScheduleMessageRequest = FromClient({
  content: SendContent,
  parentId: Type.Optional(Uuid),
  attachmentIds: Type.Optional(AttachmentIds),
  sendAt: Timestamp,
});
export type ScheduleMessageRequest = Static<typeof ScheduleMessageRequest>;
export const ScheduledMessage = Type.Object({
  id: Uuid,
  channelId: Uuid,
  parentId: Type.Union([Uuid, Type.Null()]),
  content: SendContent,
  attachments: Type.Array(Attachment),
  sendAt: Timestamp,
  state: ScheduledMessageState,
  sentMessageId: Type.Union([Uuid, Type.Null()]),
  failureCode: Type.Union([Type.String(), Type.Null()]),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ScheduledMessage = Static<typeof ScheduledMessage>;
export const ScheduledMessageList = Type.Array(ScheduledMessage, {
  maxItems: SCHEDULED_MESSAGES_MAX,
});
export type ScheduledMessageList = Static<typeof ScheduledMessageList>;

export const SaveMessageRequest = FromClient({ state: Type.Optional(SavedState) });
export type SaveMessageRequest = Static<typeof SaveMessageRequest>;

/** A message the person saved, as they can read it now. `id` is the save's, and the page's cursor. */
export const SavedItem = Type.Object({
  id: Uuid,
  state: SavedState,
  savedAt: Type.String({ format: 'date-time' }),
  message: Message,
});
export type SavedItem = Static<typeof SavedItem>;

/** `GET /api/workspaces/:workspaceId/saved` — one state's saves, newest first, keyset on `id`. */
export const SavedPage = Page(SavedItem);
export type SavedPage = Static<typeof SavedPage>;

export const SavedQuery = FromClient({
  state: SavedState,
  before: Type.Optional(Uuid),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: PAGE_LIMIT.max, default: PAGE_LIMIT.default }),
  ),
});
export type SavedQuery = Static<typeof SavedQuery>;

/**
 * `GET /api/workspaces/:workspaceId/saved/ids` — which messages the person has saved, to mark them
 * where they are read. Not paged: bounded by `SAVED_MAX`.
 */
export const SavedIds = Type.Array(
  Type.Object({ messageId: Uuid, channelId: Uuid, state: SavedState }),
  { maxItems: SAVED_MAX },
);
export type SavedIds = Static<typeof SavedIds>;

// ── A channel's files (#485, D-129) ─────────────────────────────────────────

/**
 * A file in a channel, with the message that carried it — enough to name who shared it and when,
 * and to open it where it was said. `parentId` is the thread's root when it was said in one.
 */
export const ChannelFile = Type.Object({
  attachment: Attachment,
  messageId: Uuid,
  parentId: Type.Union([Uuid, Type.Null()]),
  sender: User,
  sentAt: Timestamp,
});
export type ChannelFile = Static<typeof ChannelFile>;

/**
 * `GET /api/channels/:channelId/files` — the files of messages not deleted, newest message first.
 * The cursor is a file's `attachment.id`: the page after it is read from its message on.
 */
export const FilePage = Page(ChannelFile);
export type FilePage = Static<typeof FilePage>;

/** Older than a file, one way only: the list is read back from the newest. */
export const FileQuery = Type.Pick(PageQuery, ['before', 'limit']);
export type FileQuery = Static<typeof FileQuery>;

// ── A channel's pins (#485, D-130) ──────────────────────────────────────────

/** How many messages a channel keeps pinned — what its Pins list holds, unpaged. */
export const PINS_MAX = 50;

/**
 * A pinned message, as the caller can read it now, with who pinned it — null once that person's
 * account is gone — and when.
 */
export const PinnedMessage = Type.Object({
  message: Message,
  pinnedBy: Type.Union([User, Type.Null()]),
  pinnedAt: Timestamp,
});
export type PinnedMessage = Static<typeof PinnedMessage>;

/** `GET /api/channels/:channelId/pins` — newest pin first, of messages not deleted; bounded, not paged. */
export const PinList = Type.Array(PinnedMessage, { maxItems: PINS_MAX });
export type PinList = Static<typeof PinList>;

// ── Profiles (#488, D-131) ──────────────────────────────────────────────────

/**
 * `PATCH /api/me/profile` — what to change; a field left out is left as it is, and null clears it.
 * The words are trimmed by the server, and words that trim to nothing clear the field too. The time
 * zone must be one the server's runtime knows.
 */
export const UpdateProfileRequest = FromClient({
  title: Type.Optional(
    Type.Union([
      Type.String({ minLength: 1, maxLength: PROFILE_TITLE_MAX, format: 'name' }),
      Type.Null(),
    ]),
  ),
  timeZone: Type.Optional(
    Type.Union([
      Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_+\\-/]+$' }),
      Type.Null(),
    ]),
  ),
  status: Type.Optional(
    Type.Union([
      Type.String({ minLength: 1, maxLength: PROFILE_STATUS_MAX, format: 'name' }),
      Type.Null(),
    ]),
  ),
});
export type UpdateProfileRequest = Static<typeof UpdateProfileRequest>;

// ── A repository's feed into a channel (#79, D-134) ────────────────────────

/** The events a feed may post (D-134 §1): not CI, checks or deploys. */
export const GITHUB_FEED_EVENTS = ['push', 'pull_request', 'issues', 'release'] as const;
export const GitHubFeedEventName = Type.Union(GITHUB_FEED_EVENTS.map((name) => Type.Literal(name)));
export type GitHubFeedEventName = Static<typeof GitHubFeedEventName>;

/** How many repositories one channel may hear from. */
export const GITHUB_FEEDS_PER_CHANNEL_MAX = 10;

/**
 * Why a feed's last delivery was not posted, said where the feed was set up (D-134 §8). A bad
 * signature is not one: anybody may send one, and it would bury a real failure.
 */
export const GitHubFeedFailure = Type.Union([
  /** The channel was archived: its feeds post nowhere. */
  Type.Literal('channel_archived'),
  /** The delivery was from another repository than the feed's first. */
  Type.Literal('repository_mismatch'),
  /** Signed, but not an event of the shape GitHub documents. */
  Type.Literal('payload_invalid'),
  /** One delivery too many for the feed's bucket: GitHub does not send it again on its own. */
  Type.Literal('rate_limited'),
]);
export type GitHubFeedFailure = Static<typeof GitHubFeedFailure>;

export const GitHubFeed = Type.Object({
  id: Uuid,
  channelId: Uuid,
  /** `owner/name`, in lower case, as GitHub compares it. */
  repository: Type.String({ minLength: 3, maxLength: 140 }),
  events: Type.Array(GitHubFeedEventName, { minItems: 1, uniqueItems: true }),
  createdAt: Timestamp,
  /** When GitHub last reached it with a signed delivery; null until it has. */
  lastDeliveryAt: Type.Union([Timestamp, Type.Null()]),
  lastFailure: Type.Union([Type.Object({ reason: GitHubFeedFailure, at: Timestamp }), Type.Null()]),
});
export type GitHubFeed = Static<typeof GitHubFeed>;

/** `GET /api/channels/:channelId/github-feeds` — an owner's or an admin's; oldest first, bounded. */
export const GitHubFeedList = Type.Array(GitHubFeed, { maxItems: GITHUB_FEEDS_PER_CHANNEL_MAX });
export type GitHubFeedList = Static<typeof GitHubFeedList>;

/** `POST /api/channels/:channelId/github-feeds` — a repository as GitHub writes it, either case. */
export const CreateGitHubFeedRequest = FromClient({
  repository: Type.String({ pattern: GITHUB_REPOSITORY_PATTERN }),
  events: Type.Array(GitHubFeedEventName, {
    minItems: 1,
    maxItems: GITHUB_FEED_EVENTS.length,
    uniqueItems: true,
  }),
});
export type CreateGitHubFeedRequest = Static<typeof CreateGitHubFeedRequest>;

/**
 * The feed made, with what GitHub needs to reach it: the address, on this server's origin, and the
 * secret — in this answer only, never again (D-134 §3).
 */
export const CreatedGitHubFeed = Type.Object({
  feed: GitHubFeed,
  webhookPath: Type.String({ pattern: '^/api/webhooks/github/[0-9a-f-]{36}$' }),
  secret: Type.String({ pattern: '^[0-9a-f]{64}$' }),
});
export type CreatedGitHubFeed = Static<typeof CreatedGitHubFeed>;

/**
 * `POST /api/webhooks/github/:feedId` — what became of a delivery GitHub may be told about (D-134 §5):
 * `posted` (`201`), or received and nothing to post — the same delivery again, an event this feed
 * does not post, a ping (`200`).
 */
export const WebhookAnswer = Type.Object({
  outcome: Type.Union([
    Type.Literal('posted'),
    Type.Literal('duplicate'),
    Type.Literal('ignored'),
    Type.Literal('pinged'),
  ]),
});
export type WebhookAnswer = Static<typeof WebhookAnswer>;

// ── A message's earlier versions (#82, D-135) ───────────────────────────────

/** How many earlier versions of one message are kept: past it, the oldest goes (D-135 §3). */
export const MESSAGE_VERSIONS_KEPT = 100;

/**
 * What a message said before an edit, and when that edit replaced it. The message itself is its
 * current version; this is what came before, the latest first.
 */
export const MessageVersion = Type.Object({
  id: Uuid,
  content: Type.String(),
  replacedAt: Timestamp,
});
export type MessageVersion = Static<typeof MessageVersion>;

/** `GET /api/messages/:messageId/versions` — newest first, keyset on the version's id. */
export const MessageVersionPage = Page(MessageVersion);
export type MessageVersionPage = Static<typeof MessageVersionPage>;

// ── Who is online (#480, D-136) ─────────────────────────────────────────────

/**
 * `GET /api/workspaces/:workspaceId/presence` — the workspace's members online now, each at the
 * version this node said it; a member not listed is offline. Read when a workspace opens, and again a
 * grace after a reconnect; `PRESENCE` frames keep it current between.
 */
export const PresenceSnapshot = Type.Object({
  online: Type.Array(PresenceChange),
  /** The version everyone not listed is offline at. */
  version: Type.Integer({ minimum: 0 }),
});
export type PresenceSnapshot = Static<typeof PresenceSnapshot>;

// ── Incidents (#487, D-137) ─────────────────────────────────────────────────

/**
 * An incident declared in a channel: how bad, where it is, and who declared it when. The channel's
 * open one, or once none is open the latest — `GET /api/channels/:channelId/incident`.
 */
/** How many may be responding to one incident (D-137 §3). */
export const INCIDENT_RESPONDERS_MAX = 50;

/** The longest runbook link (D-137 §3); `https:` only, which the server parses as a URL too. */
export const RUNBOOK_URL_MAX = 2048;
export const RunbookUrl = Type.String({
  maxLength: RUNBOOK_URL_MAX,
  pattern: '^https://[^\\s]+$',
  format: 'link',
});

const incidentFields = {
  /** The client's UUIDv7, chosen when it declared: a retry finds the same incident (D-33). */
  id: Uuid,
  channelId: Uuid,
  severity: IncidentSeverity,
  /** Null once the person who declared it is gone. */
  declaredBy: Type.Union([User, Type.Null()]),
  declaredAt: Timestamp,
  /** Who is responding, first brought in first; each a member of the channel (D-137 §3). */
  responders: Type.Array(User, { maxItems: INCIDENT_RESPONDERS_MAX }),
  /** The runbook it follows; null when none is set. */
  runbookUrl: Type.Union([RunbookUrl, Type.Null()]),
  /** The postmortem draft, markdown; empty until written. */
  postmortem: SendContent,
  /** How many times the postmortem was saved: what a save says it was edited from. */
  postmortemVersion: Type.Integer({ minimum: 0 }),
};
/** Open, or resolved with its instant — never one without the other (`incidents_resolved_at`). */
export const Incident = Type.Union([
  Type.Object({ ...incidentFields, status: OpenIncidentStatus, resolvedAt: Type.Null() }),
  Type.Object({ ...incidentFields, status: Type.Literal('resolved'), resolvedAt: Timestamp }),
]);
export type Incident = Static<typeof Incident>;

/** `GET /api/channels/:channelId/incident` — null when the channel never had one. */
export const IncidentResponse = Type.Object({ incident: Type.Union([Incident, Type.Null()]) });
export type IncidentResponse = Static<typeof IncidentResponse>;

/** `POST /api/channels/:channelId/incident` — declared at this severity, investigating. */
export const DeclareIncidentRequest = FromClient({
  id: Uuid,
  severity: IncidentSeverity,
});
export type DeclareIncidentRequest = Static<typeof DeclareIncidentRequest>;

/**
 * `PATCH /api/channels/:channelId/incident/:incidentId` — what to change, at least one thing. The
 * last change wins: in an incident speed is worth more than a refusal (D-137 §5).
 */
export const ChangeIncidentRequest = FromClient(
  {
    status: Type.Optional(IncidentStatus),
    severity: Type.Optional(IncidentSeverity),
    /** The runbook's link, or null to clear it. */
    runbookUrl: Type.Optional(Type.Union([RunbookUrl, Type.Null()])),
  },
  { minProperties: 1 },
);
export type ChangeIncidentRequest = Static<typeof ChangeIncidentRequest>;

/**
 * `PUT /api/channels/:channelId/incident/:incidentId/postmortem` — the draft as written, from the
 * version it was edited from: one saved since is a conflict, never written over (D-137 §5).
 */
export const SavePostmortemRequest = FromClient({
  /** As long as a message may be, and held to what a message's words may hold; empty clears it. */
  content: SendContent,
  version: Type.Integer({ minimum: 0 }),
});
export type SavePostmortemRequest = Static<typeof SavePostmortemRequest>;

/** What one entry of an incident's timeline says changed. */
export const IncidentChange = Type.Union([
  Type.Object({ kind: Type.Literal('declared'), severity: IncidentSeverity }),
  // From an open status only: nothing moves a resolved incident (D-137 §3).
  Type.Object({ kind: Type.Literal('status'), from: OpenIncidentStatus, to: IncidentStatus }),
  Type.Object({ kind: Type.Literal('severity'), from: IncidentSeverity, to: IncidentSeverity }),
  /** Somebody brought in to respond, or taken off; null once they are gone. */
  Type.Object({ kind: Type.Literal('responder_added'), user: Type.Union([User, Type.Null()]) }),
  Type.Object({ kind: Type.Literal('responder_removed'), user: Type.Union([User, Type.Null()]) }),
  /** The runbook's link set, or cleared (null). */
  Type.Object({ kind: Type.Literal('runbook'), url: Type.Union([RunbookUrl, Type.Null()]) }),
  /** The postmortem saved, at this version; its words are the incident's. */
  Type.Object({ kind: Type.Literal('postmortem'), version: Type.Integer({ minimum: 1 }) }),
]);
export type IncidentChange = Static<typeof IncidentChange>;

/** One entry of an incident's timeline: what changed, by whom (null once they are gone), when. */
export const IncidentUpdate = Type.Object({
  id: Uuid,
  at: Timestamp,
  actor: Type.Union([User, Type.Null()]),
  change: IncidentChange,
});
export type IncidentUpdate = Static<typeof IncidentUpdate>;

/** `GET /api/channels/:channelId/incident/:incidentId/updates` — newest first, keyset on the id. */
export const IncidentUpdatePage = Page(IncidentUpdate);
export type IncidentUpdatePage = Static<typeof IncidentUpdatePage>;

// ── Signing in (#81, D-138) ─────────────────────────────────────────────────

/**
 * `GET /api/auth/methods` — how this server signs people in: GitHub when an app is connected, email
 * when it can send a link (D-138 §6, D-179), and single sign-on when an OpenID Connect provider is
 * connected (D-200). None of the three is a server whose setup is not done. Asked
 * before anybody is signed in, so the screen offers only what works.
 */
export const AuthMethods = Type.Object({
  github: Type.Boolean(),
  email: Type.Boolean(),
  /**
   * Single sign-on by the organisation's OpenID Connect provider (D-200): `null` where none is connected,
   * else the name the button carries — the operator's `OIDC_NAME`, or `null` for the default, which the client
   * words in the person's language.
   */
  oidc: Type.Union([Type.Object({ name: Type.Union([Type.String(), Type.Null()]) }), Type.Null()]),
  /** Who may make an account: anybody, or only the holder of an invitation (R51). */
  signUp: Type.Union([Type.Literal('open'), Type.Literal('invite-only')]),
});
export type AuthMethods = Static<typeof AuthMethods>;

/**
 * What a client that is not a browser learns before anybody signs in (`GET /api/client`, `API.md` §2,
 * D-186): which server this is, which wire contract it speaks, the address it answers to — the only
 * one the socket's `Origin` check accepts — the minimum an installed client must meet, and the same
 * sign-in methods the sign-in screen offers, so one call is enough to draw it.
 *
 * `minClient` is per platform, and every limit in it may be `null`: a limit the operator did not set.
 */
export const ClientMinimum = Type.Object({
  contractVersion: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  appVersion: Type.Union([Type.String(), Type.Null()]),
  downloadUrl: Type.Union([Type.String(), Type.Null()]),
});
export type ClientMinimum = Static<typeof ClientMinimum>;

/**
 * Additive API support, not authentication or permission. Only an explicitly true known flag
 * confirms support; an absent object/flag or false does not. This response object stays open so
 * an older client can ignore capability names introduced later (D-58).
 */
export const ClientCapabilities = Type.Object({
  scheduledMessages: Type.Optional(Type.Boolean()),
  messageReminders: Type.Optional(Type.Boolean()),
  personalMessageDeletion: Type.Optional(Type.Boolean()),
  notificationTypeFilters: Type.Optional(
    Type.Boolean({
      description: 'GET /api/notifications accepts the types CSV filter before pagination.',
    }),
  ),
});
export type ClientCapabilities = Static<typeof ClientCapabilities>;

export const ClientInfo = Type.Object({
  capabilities: Type.Optional(ClientCapabilities),
  server: Type.Object({ version: Type.String() }),
  contractVersion: Type.Integer({ minimum: 1 }),
  appUrl: Type.String(),
  minClient: Type.Object({ macos: ClientMinimum }),
  auth: AuthMethods,
});
export type ClientInfo = Static<typeof ClientInfo>;

/**
 * Where a native client is sent back once the person has said yes: a fixed address of the server's own
 * choosing, so the client names no redirect and there is no open redirect to find (D-191). The one a
 * client registers a scheme for.
 */
export const NATIVE_REDIRECT = 'purlay://auth';

/**
 * The application's challenge: the SHA-256 of a verifier it made and keeps, in base64url without padding —
 * 43 characters. What binds the code it is about to be given to the application that asked for it.
 */
export const NATIVE_CHALLENGE_PATTERN = '^[A-Za-z0-9_-]{43}$';

/** The application's verifier: 32 to 96 random bytes in base64url (43 to 128 characters). */
export const NATIVE_VERIFIER_PATTERN = '^[A-Za-z0-9_-]{43,128}$';

/**
 * The application's own word, handed back in the redirect so it can tell the answer to its question from
 * somebody else's. Only the characters of base64url, because it is written into a URL.
 */
export const NATIVE_STATE_PATTERN = '^[A-Za-z0-9_-]{16,128}$';

/**
 * A name for the device, shown by whoever lists sessions: any characters but control and line-breaking
 * ones, and the invisible ones that change how the text around them reads — zero-width and directional
 * marks, embeddings, overrides and isolates, the byte-order mark — so a name cannot be made to look like
 * another device's.
 */
export const NATIVE_DEVICE_NAME_PATTERN =
  '^[^\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069\\ufeff]{1,64}$';

/** The code, as `POST /api/native/authorize` makes it: 32 random bytes in hex. */
export const NATIVE_CODE_PATTERN = '^[0-9a-f]{64}$';

/** `POST /api/native/authorize` (D-191): the person, signed in, says yes to the application that sent them. */
export const NativeAuthorizeRequest = FromClient({
  challenge: Type.String({ pattern: NATIVE_CHALLENGE_PATTERN }),
  state: Type.String({ pattern: NATIVE_STATE_PATTERN }),
});
export type NativeAuthorizeRequest = Static<typeof NativeAuthorizeRequest>;

/** Where to send the browser next: `purlay://auth?code=…&state=…`. */
export const NativeAuthorizeResponse = Type.Object({ redirect: Type.String() });
export type NativeAuthorizeResponse = Static<typeof NativeAuthorizeResponse>;

/** `POST /api/native/token` (D-191): the application spends its code with the verifier it never sent. */
export const NativeTokenRequest = FromClient({
  code: Type.String({ pattern: NATIVE_CODE_PATTERN }),
  verifier: Type.String({ pattern: NATIVE_VERIFIER_PATTERN }),
  device: FromClient({ name: Type.String({ pattern: NATIVE_DEVICE_NAME_PATTERN }) }),
});
export type NativeTokenRequest = Static<typeof NativeTokenRequest>;

/**
 * `POST /auth/email` — send a sign-in link to this address, in this language. Answered `202` whatever
 * the address: whether an account has it is never said (D-138 §1). An invitation the asker holds rides
 * in the link's fragment, since the tab that holds it is not the one the mail opens (D-138 §4).
 */
export const EmailSignInRequest = FromClient({
  email: Type.String({ format: 'email', maxLength: 254 }),
  locale: SignInLocale,
  invitation: Type.Optional(InvitationToken),
  /** The native application's challenge and state, carried in the link's fragment (D-191). */
  native: Type.Optional(NativeAuthorizeRequest),
});
export type EmailSignInRequest = Static<typeof EmailSignInRequest>;

/**
 * `POST /auth/email/preview` and `POST /auth/email/consume` — the token a link carried in its fragment
 * (D-138 §4), posted by the page that read it; never in a path, so never in a log.
 */
export const EmailSignInToken = FromClient({ token: Type.String({ pattern: '^[0-9a-f]{64}$' }) });
export type EmailSignInToken = Static<typeof EmailSignInToken>;

/** What the page shows before the person signs in: the address the link was sent to (D-138 §4). */
export const EmailSignInPreview = Type.Object({ email: Type.String() });
export type EmailSignInPreview = Static<typeof EmailSignInPreview>;

/**
 * `GET /api/me/sign-in` — the ways the caller signs in (D-176): their address, whether a link sent to
 * it signs them in (an account made by email, linked to GitHub or not — never one GitHub made,
 * D-138 §2), and the GitHub account linked to it, if any (D-179 §5). `login` is null for a GitHub account whose
 * login is not known yet (D-169 §4). Only ever the caller's own.
 */
export const MySignIn = Type.Object({
  email: Type.String(),
  emailLinks: Type.Boolean(),
  /** Whether the account has a password to sign in or to change: the setup's administrator does. */
  hasPassword: Type.Boolean(),
  github: Type.Union([
    Type.Object({ login: Type.Union([Type.String(), Type.Null()]) }),
    Type.Null(),
  ]),
  /** Whether the account is linked to the organisation's single sign-on (D-200); only ever the caller's own. */
  oidc: Type.Boolean(),
});
export type MySignIn = Static<typeof MySignIn>;

/**
 * `GET /api/me/sessions` — where the caller is signed in (D-193): each live session of theirs, newest use first. A
 * session is named by what the person chose, never by what the server knows of it: the native application's
 * device name, and `null` for a browser's. No address, no user agent and nothing that could end the session
 * but its own `id` (D-179 §3).
 */
export const DeviceSession = Type.Object({
  id: Uuid,
  /** `native` where the session was handed to the application by a code (D-191); every other is a `browser`. */
  kind: Type.Union([Type.Literal('browser'), Type.Literal('native')]),
  name: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
  /** Refreshed at most once an hour (D-60): precise to *when was this device last seen*, not to the minute. */
  lastUsedAt: Type.String({ format: 'date-time' }),
  expiresAt: Type.String({ format: 'date-time' }),
  /** The session this request came in on: ending it is signing out. */
  current: Type.Boolean(),
});
export type DeviceSession = Static<typeof DeviceSession>;

export const DeviceSessionList = Type.Object({ data: Type.Array(DeviceSession) });
export type DeviceSessionList = Static<typeof DeviceSessionList>;

/** The most live sessions one answer names: a person with more than this has been signing in without signing out. */
export const DEVICE_SESSIONS_MAX = 100;

// ── The setup in the browser (D-179 §4) ──────────────────────────────────────
// The answers are plain types in `setup.ts` (`SetupStatus`, `SetupState`, …): the browser only reads
// them, and a schema built at the top of a module stays in its bundle whether read or not.

/** `POST /setup/claim` — the setup code from the server's log, as typed: any case, dashes or not. */
export const SetupClaimRequest = FromClient({ code: Type.String({ minLength: 1, maxLength: 64 }) });
export type SetupClaimRequest = Static<typeof SetupClaimRequest>;

/** `POST /setup/address` — the server's address (`APP_URL`), seen and confirmed (Ruling R35). */
export const SetupAddressRequest = FromClient({ confirmed: Type.Literal(true) });
export type SetupAddressRequest = Static<typeof SetupAddressRequest>;

/**
 * `POST /setup/admin` — the administrator. Bounded here only against a body nobody types; the rules of
 * each field are the server's (`passwordProblem`, the name's and the address's), said by name.
 */
export const SetupAdminRequest = FromClient({
  name: Type.String({ maxLength: 512 }),
  email: Type.String({ maxLength: 254 }),
  password: Type.String({ maxLength: 1024 }),
});
export type SetupAdminRequest = Static<typeof SetupAdminRequest>;

/** `POST /setup/policy` — who may make an account (D-179 §4.7). */
export const SetupPolicyRequest = FromClient({
  signUp: Type.Union([Type.Literal('invite-only'), Type.Literal('open')]),
});
export type SetupPolicyRequest = Static<typeof SetupPolicyRequest>;

/** A step that is passed without connecting anything: GitHub or mail, skipped. */
const Skipped = FromClient({ skip: Type.Literal(true) });

/**
 * `POST /setup/github` — the OAuth app's pair, tried against GitHub; kept only when the try works and
 * `save` says to. Or the step skipped.
 */
export const SetupGitHubRequest = Type.Union([
  FromClient({
    clientId: Type.String({ minLength: 1, maxLength: 128 }),
    clientSecret: Type.String({ minLength: 1, maxLength: 256 }),
    save: Type.Optional(Type.Boolean()),
  }),
  Skipped,
]);
export type SetupGitHubRequest = Static<typeof SetupGitHubRequest>;

/**
 * `POST /setup/smtp` — the relay (`smtpUrl`, its credentials in it — named so the log never writes it)
 * and the sender, tried with the administrator's verification letter in `locale`; kept only when the
 * try works and `save` says to. Or the step skipped. Or the letter sent again through the relay
 * already kept — which the client cannot name, since the relay's address is never shown to it again.
 */
export const SetupSmtpRequest = Type.Union([
  FromClient({
    smtpUrl: Type.String({ minLength: 1, maxLength: 2048 }),
    from: Type.String({ minLength: 1, maxLength: 254 }),
    allowPlaintext: Type.Boolean(),
    locale: SignInLocale,
    save: Type.Optional(Type.Boolean()),
  }),
  Skipped,
  FromClient({ resend: Type.Literal(true), locale: SignInLocale }),
]);
export type SetupSmtpRequest = Static<typeof SetupSmtpRequest>;

// ── Administration → Server (D-179 §4.8) ─────────────────────────────────────

/** `POST /api/server/github` — GitHub's OAuth app, tried with these values and kept only if it works. */
export const ServerGitHubRequest = FromClient({
  clientId: Type.String({ minLength: 1, maxLength: 128 }),
  clientSecret: Type.String({ minLength: 1, maxLength: 256 }),
});
export type ServerGitHubRequest = Static<typeof ServerGitHubRequest>;

/** The longest name a single sign-on button carries (D-200): one short line, never a sentence. */
export const OIDC_NAME_MAX = 40;

/**
 * `POST /api/server/oidc` — the OpenID Connect provider (D-200), its discovery and its client tried with these
 * values and kept only if they work. `name` is the button's label; empty is the default.
 */
export const ServerOidcRequest = FromClient({
  issuer: Type.String({ minLength: 1, maxLength: 512 }),
  clientId: Type.String({ minLength: 1, maxLength: 256 }),
  clientSecret: Type.String({ minLength: 1, maxLength: 1024 }),
  name: Type.Optional(Type.String({ maxLength: OIDC_NAME_MAX })),
});
export type ServerOidcRequest = Static<typeof ServerOidcRequest>;

/** `POST /api/server/smtp` — the relay, tried with a test letter to the caller, kept only if it works. */
export const ServerSmtpRequest = FromClient({
  smtpUrl: Type.String({ minLength: 1, maxLength: 2048 }),
  from: Type.String({ minLength: 1, maxLength: 254 }),
  allowPlaintext: Type.Boolean(),
});
export type ServerSmtpRequest = Static<typeof ServerSmtpRequest>;

/** `DELETE /api/server/github`, `/smtp` and `/oidc` — the body is optional; `confirmLastChannel` is the only field. */
export const ServerDisconnectRequest = FromClient({
  confirmLastChannel: Type.Optional(Type.Boolean()),
});
export type ServerDisconnectRequest = Static<typeof ServerDisconnectRequest>;

/** `POST /api/server/policy` — who may make an account. */
export const ServerPolicyRequest = FromClient({
  signUp: Type.Union([Type.Literal('invite-only'), Type.Literal('open')]),
});
export type ServerPolicyRequest = Static<typeof ServerPolicyRequest>;

/** The longest list of workspace creators the page takes, and a GitHub login's longest. */
export const WORKSPACE_CREATOR_LOGINS_MAX = 100;

/** `POST /api/server/creators` — who may make a workspace (D-155, D-169): the setting's own values. */
export const ServerCreatorsRequest = FromClient({
  workspaceCreators: Type.Union([
    FromClient({ kind: Type.Union([Type.Literal('first'), Type.Literal('anyone')]) }),
    FromClient({
      kind: Type.Literal('listed'),
      logins: Type.Array(Type.String({ minLength: 1, maxLength: 39 }), {
        minItems: 1,
        maxItems: WORKSPACE_CREATOR_LOGINS_MAX,
      }),
    }),
  ]),
});
export type ServerCreatorsRequest = Static<typeof ServerCreatorsRequest>;

/** `POST /setup/verify` — the token the administrator's link carried in its fragment. */
export const SetupVerifyRequest = FromClient({
  token: Type.String({ pattern: '^[0-9a-f]{64}$', maxLength: 64 }),
});
export type SetupVerifyRequest = Static<typeof SetupVerifyRequest>;
