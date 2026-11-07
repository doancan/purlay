/**
 * The core's inbox of what modules told a person (D-286): one list for every module that runs, apart from chat's own
 * notifications (`NotificationPage`), which stay bound to a message and a channel. A client shows it as its own section.
 */
import { Type, type Static } from '@sinclair/typebox';
import { PAGE_LIMIT } from './api';
import { FromClient, Timestamp, Uuid } from './models';

/**
 * One thing a module told the caller. `module` and `kind` are words the module that wrote it declared (`kind` is a `type` of
 * its manifest's `notifications`): a client that does not know one shows it plainly and does not fail. `subject` says what
 * it is about, by the module's own word and its id, so a client can open it. `params` are short plain values for the
 * sentence a client builds from `kind` (an issue's title), never a body. `actorId` is who did it, `null` once that account
 * is gone.
 */
export const InboxEntry = Type.Object({
  id: Uuid,
  module: Type.String(),
  kind: Type.String(),
  actorId: Type.Union([Uuid, Type.Null()]),
  subject: Type.Object({ type: Type.String(), id: Uuid }),
  params: Type.Record(
    Type.String(),
    Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
  ),
  readAt: Type.Union([Timestamp, Type.Null()]),
  createdAt: Timestamp,
});
export type InboxEntry = Static<typeof InboxEntry>;

/**
 * `GET /api/workspaces/:workspaceId/inbox` — the caller's own, newest first, keyset on `id` (`nextCursor` is the next page's
 * `before`). `unreadCount` is every unread notice the caller has in the workspace, not the page's. Only the notices of
 * modules this server runs are listed and counted: those of a module that is off are kept and not shown.
 */
export const InboxPage = Type.Object({
  data: Type.Array(InboxEntry),
  nextCursor: Type.Union([Uuid, Type.Null()]),
  unreadCount: Type.Integer({ minimum: 0 }),
});
export type InboxPage = Static<typeof InboxPage>;

export const InboxQuery = FromClient({
  unreadOnly: Type.Optional(Type.Boolean()),
  before: Type.Optional(Uuid),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: PAGE_LIMIT.max, default: PAGE_LIMIT.default }),
  ),
});
export type InboxQuery = Static<typeof InboxQuery>;

/** `POST /api/workspaces/:workspaceId/inbox/read` — these, by id; or every unread notice the caller has in the workspace. */
export const MarkInboxReadRequest = Type.Union([
  FromClient({ ids: Type.Array(Uuid, { minItems: 1, maxItems: PAGE_LIMIT.max }) }),
  FromClient({ all: Type.Literal(true) }),
]);
export type MarkInboxReadRequest = Static<typeof MarkInboxReadRequest>;
