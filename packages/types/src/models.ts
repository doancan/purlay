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

export const Channel = Type.Object({
  id: Uuid,
  workspaceId: Uuid,
  /** Null for a direct message, which is identified by its members (D-6). */
  name: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
  topic: Type.Union([Type.String(), Type.Null()]),
  type: ChannelType,
  /** Denormalised so the sidebar can order channels without touching `messages`. */
  lastMessageAt: Type.Union([Timestamp, Type.Null()]),
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
});
export type Message = Static<typeof Message>;
