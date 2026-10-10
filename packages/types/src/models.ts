/**
 * The entities as they cross the wire.
 *
 * These are **not** the database rows. A row carries things no client should
 * receive — an email address every workspace member could then read, a soft-delete
 * timestamp, a GitHub identifier — and `ARCHITECTURE.md` §10 already forbids
 * logging most of them. What a client gets is decided here, once.
 *
 * Authored as TypeBox schemas with the TypeScript types derived from them, so
 * one definition both validates at runtime and types at compile time
 * (`ARCHITECTURE.md` §2). Hand-written types beside the schemas would be two
 * definitions of every shape.
 *
 * **camelCase on the wire, snake_case in the database.** The service layer maps
 * between them. A plugin that rewrites every identifier automatically would make
 * the query builder and the hand-written SQL disagree, and D-20 chose to write
 * SQL and joins by hand.
 */
import { Type, type Static, type TObject, type TProperties } from '@sinclair/typebox';
// Side effect: registers the string formats these schemas use. Without it
// TypeBox rejects every value carrying a `format`, valid ones included.
import './formats';

/** UUID, and for `messages` specifically a UUIDv7 the client generated (D-8). */
export const Uuid = Type.String({ format: 'uuid' });

/** ISO 8601, UTC. Never used for ordering — ordering is keyset on the id (D-8). */
export const Timestamp = Type.String({ format: 'date-time' });

/**
 * A shape the client sends.
 *
 * Unknown properties are **refused**, not ignored. TypeBox does not set
 * `additionalProperties: false` and neither does the server framework, so a
 * request carrying a field nobody validates returns 200 and the field is
 * silently dropped — a client sending `roleOverride` would be told it worked.
 * Silently discarding input is the failure class this project refuses everywhere
 * else (`CONTRIBUTING.md` §6.4), and there is no third-party client whose extra
 * fields we owe tolerance to: there is one client and it ships with the server
 * (D-51).
 *
 * Responses deliberately do **not** use this. Adding a field to something we
 * produce must not break a client that has not been rebuilt yet. (D-57)
 */
export const FromClient = <T extends TProperties>(properties: T): TObject<T> =>
  Type.Object(properties, { additionalProperties: false });

export const UserRole = Type.Union([
  Type.Literal('owner'),
  Type.Literal('admin'),
  Type.Literal('member'),
]);
export type UserRole = Static<typeof UserRole>;

export const ChannelType = Type.Union([
  Type.Literal('public'),
  Type.Literal('private'),
  Type.Literal('direct_message'),
]);
export type ChannelType = Static<typeof ChannelType>;

/**
 * Another member, as anyone in the workspace may see them.
 *
 * No email address: it is the identity anchor (D-11) and broadcasting it to
 * every member of a workspace is a disclosure nobody asked for.
 */
export const User = Type.Object({
  id: Uuid,
  username: Type.String({ maxLength: 39 }),
  displayName: Type.String({ maxLength: 128 }),
  avatarUrl: Type.Union([Type.String(), Type.Null()]),
});
export type User = Static<typeof User>;

/** Yourself. The only shape that carries the email, and only ever to its owner. */
export const CurrentUser = Type.Composite([
  User,
  Type.Object({ email: Type.String({ format: 'email' }) }),
]);
export type CurrentUser = Static<typeof CurrentUser>;

export const Workspace = Type.Object({
  id: Uuid,
  name: Type.String({ maxLength: 64 }),
  slug: Type.String({ maxLength: 64 }),
  avatarUrl: Type.Union([Type.String(), Type.Null()]),
});
export type Workspace = Static<typeof Workspace>;

/** Your membership of a workspace. Ownership is a role, never a column on the workspace (D-22). */
export const Membership = Type.Object({
  workspace: Workspace,
  role: UserRole,
  joinedAt: Timestamp,
});
export type Membership = Static<typeof Membership>;

/**
 * A person's read position in one channel, and what is waiting beyond it
 * (`SCHEMA.md` §5.2). Maintained on write (D-13, D-35), never counted on read.
 *
 * `unreadMentionCount` is what needs *you*: an `@username` mention, any message in a
 * direct message, and a reply in a thread you started or answered (D-29). It never
 * exceeds `unreadCount` (I-6) — a message that needs you is, first, one you have not
 * read.
 */
export const ChannelState = Type.Object({
  lastReadMessageId: Type.Union([Uuid, Type.Null()]),
  unreadCount: Type.Integer({ minimum: 0 }),
  unreadMentionCount: Type.Integer({ minimum: 0 }),
});
export type ChannelState = Static<typeof ChannelState>;

export const Channel = Type.Object({
  id: Uuid,
  workspaceId: Uuid,
  /** Null for a direct message, which is identified by its members (D-6). */
  name: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
  topic: Type.Union([Type.String(), Type.Null()]),
  type: ChannelType,
  /** Denormalised so the sidebar can order channels without touching `messages`. */
  lastMessageAt: Type.Union([Timestamp, Type.Null()]),
  /**
   * What *this caller* has read here — it differs per person, which is why it is
   * a field of the response and not of the channel. Null when the caller can see
   * the channel but has not joined it (a public channel they could join).
   */
  state: Type.Union([ChannelState, Type.Null()]),
  /**
   * The other person in a direct message (the caller themselves, for a note to
   * self). Null for every other kind, which has a name instead (D-6).
   */
  peer: Type.Union([User, Type.Null()]),
});
export type Channel = Static<typeof Channel>;

/**
 * The longest message, in UTF-16 code units — what `String.length` counts.
 *
 * Sixteen thousand is roughly four hundred lines of stack trace, which `PRD.md`
 * names as something this product's users paste. It also bounds what the trigram
 * index has to digest per row. And it fits the socket's frame cap with room to
 * spare at the format's worst case of three bytes a unit — proven by a test, not
 * asserted here. The database enforces the same number (D-67).
 */
export const MESSAGE_CONTENT_MAX = 16_000;

/** What a client may send as a message's text. */
export const MessageContent = Type.String({
  minLength: 1,
  maxLength: MESSAGE_CONTENT_MAX,
  format: 'message-content',
});

/**
 * One emoji and the people who used it. The people, not a count: every client
 * needs to know whether *it* is among them, and a frame broadcast to a channel
 * cannot say that per recipient. The count is the length.
 */
export const Reaction = Type.Object({
  emoji: Type.String({ minLength: 1, maxLength: 32, format: 'emoji' }),
  userIds: Type.Array(Uuid, { minItems: 1 }),
});
export type Reaction = Static<typeof Reaction>;

/**
 * What a root message knows about its replies, so a feed of fifty roots is not
 * fifty more queries (`SCHEMA.md` §6.1). `resolvedAt` and `resolvedBy` are both set
 * or both null — the database's `resolution_is_complete` — and only a root with at
 * least one reply can be resolved (I-8).
 */
export const ThreadSummary = Type.Object({
  replyCount: Type.Integer({ minimum: 0 }),
  lastReplyAt: Type.Union([Timestamp, Type.Null()]),
  resolvedAt: Type.Union([Timestamp, Type.Null()]),
  resolvedBy: Type.Union([User, Type.Null()]),
});
export type ThreadSummary = Static<typeof ThreadSummary>;

export const Message = Type.Object({
  /** A UUIDv7 the client generated. It is also the pagination cursor. (D-8) */
  id: Uuid,
  channelId: Uuid,
  sender: User,
  content: Type.String(),
  /** Set when the message has been edited; the content is the current version. */
  editedAt: Type.Union([Timestamp, Type.Null()]),
  /**
   * A deleted message is tombstoned rather than erased, so it still occupies its
   * place in the thread it belongs to (D-9). `content` is the tombstone.
   */
  deletedAt: Type.Union([Timestamp, Type.Null()]),
  createdAt: Timestamp,
  /** The root this replies to; null for a root. Threads are two levels deep (I-1). */
  parentId: Type.Union([Uuid, Type.Null()]),
  /** A root's replies, in summary; null for a reply, which has none of its own. */
  thread: Type.Union([ThreadSummary, Type.Null()]),
  reactions: Type.Array(Reaction),
  /**
   * The people this message names with `@username`, resolved once at write time
   * (D-12) so no client re-parses a body to find out who was addressed.
   */
  mentions: Type.Array(Uuid),
});
export type Message = Static<typeof Message>;
