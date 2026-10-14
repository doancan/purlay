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
 * `PATCH /api/workspaces/:workspaceId` — an owner or an admin renames the workspace (D-124). The name
 * only: the slug is its address, in every link already pasted, and does not move (D-124).
 */
export const UpdateWorkspaceRequest = FromClient({
  name: Type.String({ minLength: 1, maxLength: WORKSPACE_NAME_MAX, format: 'name' }),
});
export type UpdateWorkspaceRequest = Static<typeof UpdateWorkspaceRequest>;

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
  'member.joined',
  'channel.created',
  'channel.renamed',
  'channel.archived',
  'integration.token_set',
  'integration.token_removed',
  'integration.feed_created',
  'integration.feed_removed',
  'invitation.created',
  'invitation.revoked',
  'message.removed_by_moderator',
  'workspace.renamed',
  'retention.purged',
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

/** `POST …/invitations` — the link just made, with its token, this once. */
export const CreatedInvitation = Type.Object({ invitation: Invitation, token: InvitationToken });
export type CreatedInvitation = Static<typeof CreatedInvitation>;

/** `GET …/invitations` — the links that still let people in, newest first. */
export const InvitationPage = Page(Invitation);
export type InvitationPage = Static<typeof InvitationPage>;

/** `POST /api/invitations/preview` and `…/accept` — the link's token, in the body. */
export const InvitationTokenRequest = FromClient({ token: InvitationToken });
export type InvitationTokenRequest = Static<typeof InvitationTokenRequest>;

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
 * `GET /api/auth/methods` — how this server signs people in: GitHub always, and email when it can send
 * a link (D-138 §6). Asked before anybody is signed in, so the screen offers only what works.
 */
export const AuthMethods = Type.Object({ email: Type.Boolean() });
export type AuthMethods = Static<typeof AuthMethods>;

/** The languages a sign-in message is written in: the interface's (D-41). */
export const SignInLocale = Type.Union([Type.Literal('en'), Type.Literal('tr')]);

/**
 * `POST /auth/email` — send a sign-in link to this address, in this language. Answered `202` whatever
 * the address: whether an account has it is never said (D-138 §1). An invitation the asker holds rides
 * in the link's fragment, since the tab that holds it is not the one the mail opens (D-138 §4).
 */
export const EmailSignInRequest = FromClient({
  email: Type.String({ format: 'email', maxLength: 254 }),
  locale: SignInLocale,
  invitation: Type.Optional(InvitationToken),
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
