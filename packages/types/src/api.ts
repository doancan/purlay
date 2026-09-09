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
import { Channel, CurrentUser, Membership, Message, User, UserRole, Uuid } from './models';

/**
 * Keyset pagination, always. `nextCursor` is the id to pass as `before`, and it
 * is null when the page is the last one.
 *
 * `OFFSET` is never accepted: it is O(n) and it shifts under concurrent inserts,
 * which in a live channel is every page (`SCHEMA.md` §6.3, D-8).
 */
export const Page = <T extends TSchema>(
  item: T,
): TObject<{ data: TArray<T>; nextCursor: TUnion<[TString, TNull]> }> =>
  Type.Object({ data: Type.Array(item), nextCursor: Type.Union([Uuid, Type.Null()]) });

export const PageQuery = Type.Object({
  /** Older than this id. */
  before: Type.Optional(Uuid),
  /** Newer than this id. */
  after: Type.Optional(Uuid),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
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

export const CreateWorkspaceRequest = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 64 }),
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

// ── Channels ────────────────────────────────────────────────────────────────

export const CreateChannelRequest = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 64 }),
  topic: Type.Optional(Type.String()),
});
export type CreateChannelRequest = Static<typeof CreateChannelRequest>;

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
export const SendMessageRequest = Type.Object({
  id: Uuid,
  content: Type.String({ minLength: 1 }),
});
export type SendMessageRequest = Static<typeof SendMessageRequest>;

export const MessagePage = Page(Message);
export type MessagePage = Static<typeof MessagePage>;

export const ChannelList = Type.Array(Channel);
export type ChannelList = Static<typeof ChannelList>;
