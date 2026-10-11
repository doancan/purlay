# Purlay — HTTP API (`API.md`)

Single source of truth for the HTTP surface. WebSocket frames are specified separately in
`ARCHITECTURE.md` §5.2 — this file covers only HTTP.

The endpoint list previously existed only as scattered mentions across `ARCHITECTURE.md`. It is
consolidated here so that adding an endpoint has one obvious place to be recorded.

**Phase markers:** ○ built · ① Phase 1 · ② Phase 2. An endpoint not marked ○ is not built. The
thread, resolution and open-questions endpoints were pulled forward by the owner (D-98, D-99) and are
marked ○ with the rest; the other Phase 1 rows are unchanged.

---

## 1. Conventions

**Auth.** Every `/api/*` endpoint requires a valid session cookie (`__Host-purlay_session`, defined in `apps/api/src/platform/cookies.ts`). There is no bearer
token and no API key in Phase 0–2.

**Tenant scope.** Endpoints under `/api/workspaces/:workspaceId/…` resolve a `WorkspaceContext`
before the handler runs (`ARCHITECTURE.md` §7.3). Endpoints addressing a resource directly
(`/api/channels/:channelId`) derive the workspace from the resource and verify membership.

**404, never 403.** A resource in another workspace returns `404`, because `403` confirms it
exists. This applies to every workspace-scoped route without exception. (D-21)

**Pagination.** Keyset only. `?before=<uuid>` returns older rows newest-first, `?after=<uuid>`
returns newer rows **oldest-first** — the order a reconnect appends them in (`ARCHITECTURE.md`
§5.4). Asking for both at once is a `400`: choosing one silently would hand a client a page it
did not ask for and could not tell apart. `?limit=` is capped at 100 (default 50). `OFFSET` is
never accepted. (D-8)

```jsonc
{ "data": [ /* … */ ], "nextCursor": "0199155c-6200-7b7f-…" }  // null when exhausted
```

**Unknown fields are refused, not ignored.** Every request body and query this API accepts is
closed: a property the contract does not declare is a `400`, never a silently discarded field. A
client that sends something the server quietly drops has been told its request succeeded when it
did not. Responses are the other way round — they may gain fields, so a client that has not been
rebuilt keeps working. (D-58)

**Errors.** One shape, always. `code` is a **discriminated union declared in `@purlay/types`** —
stable, machine-readable and exhaustively handleable; adding one breaks any switch that does not
account for it. `message` is for humans and may change. (D-47)

```jsonc
{ "error": { "code": "CHANNEL_NOT_FOUND", "message": "…", "details": {} } }
```

| Status | Meaning |
|---|---|
| `400` | Validation failed, or the body is not JSON — `details` names the fields. Never the submitted value and never the schema: a typo must not come back as a description of the server's own rules (`docs/spikes/elysia.md`) |
| `401` | No session, or the session is expired or revoked |
| `403` | Refused for what the caller is, never for what exists: a role that is insufficient (from Phase 1), a socket upgrade or a `POST`/`PUT`/`PATCH`/`DELETE` from another origin (D-39, D-80), a GitHub account with no verified address. Never across a tenant or channel boundary — that is `404` |
| `404` | Does not exist, **or exists in a workspace you are not in**, or no such route (`ROUTE_NOT_FOUND`) |
| `409` | Conflict — duplicate workspace slug, duplicate channel name, stale edit, or `MESSAGE_ID_CONFLICT` (D-33). Losing a race for a name is the same `409` as being told it is taken (D-78) |
| `413` | A JSON body over 64 KiB (`JSON_BODY_MAX_BYTES`, the socket's frame — refused by the server before it is read), or an upload over `attachment_size_limit` |
| `415` | `UNSUPPORTED_MEDIA_TYPE` — a `POST`/`PUT`/`PATCH`/`DELETE` whose body is not `application/json` (a form, `text/plain`, or a body with no type). A request with no body at all, such as logout, is unaffected (D-80) |
| `429` | Rate limited |
| `500` | Something the server did not anticipate — `INTERNAL`, carrying no detail of the cause |
| `503` | This process should not receive traffic — `/health/ready` while not ready or draining for shutdown — or, from any endpoint, `DATABASE_UNAVAILABLE`: no database connection within 3 s, nothing was changed, retry shortly (D-87) |

**Idempotency.** `POST` of a message carries a client-generated UUIDv7 as its `id`. Re-sending
the same id **by the same sender in the same channel** is a no-op that returns the existing
message, so a retry after a timeout can never duplicate. (D-8) The id is validated first — v7
shape and a plausible timestamp — and a collision with somebody else's message returns `409`
without disclosing it. (D-33)

---

## 2. Authentication

| | Method | Path | Notes |
|:-:|---|---|---|
| ○ | `GET` | `/auth/github` | 302 to GitHub, scopes `read:user user:email`. Sets a short-lived signed `state` cookie (D-38) |
| ○ | `GET` | `/auth/github/callback` | Verifies `state`, exchanges the code, resolves identity (D-38), upserts the user, applies open join if configured (D-37), creates a session, 302 to `APP_URL` |
| ○ | `POST` | `/auth/logout` | Revokes the current session |
| ○ | `POST` | `/auth/logout-all` | Revokes every session for the user. Phase 0 rather than Phase 1: *sign out everywhere* is the capability D-11 chose database-backed sessions **for**, so shipping the cost without it makes the decision unpaid |
| ○ | `GET` | `/api/me` | Current user plus workspace memberships |
| ② | `POST` | `/api/me/erase` | Anonymises the account and revokes every session. **Never cascades to messages** (D-27) |

Sign-in refuses with `EMAIL_REQUIRED` when the GitHub account exposes no primary verified email,
and with `ACCOUNT_EMAIL_CONFLICT` when that address already belongs to a different `github_id`.
Neither case is linked silently. (D-38)

`state` verification is mandatory: without it the callback is a CSRF endpoint that signs
victims into an attacker's account. (`ARCHITECTURE.md` §7.1)

Scheduled work has **no HTTP surface**. Every background job is a CLI command run by an external
scheduler (D-30); there is no `/api/admin/jobs`, because its data is instance-wide and would need
an instance-administrator role this product does not have.

---

## 3. Workspaces & Members

| | Method | Path | Role |
|:-:|---|---|---|
| ○ | `GET` | `/api/workspaces` | — (own memberships) |
| ○ | `POST` | `/api/workspaces` | — (creator becomes `owner`) |
| ○ | `GET` | `/api/workspaces/:workspaceId` | member |
| ① | `PATCH` | `/api/workspaces/:workspaceId` | admin |
| ① | `DELETE` | `/api/workspaces/:workspaceId` | owner |
| ○ | `GET` | `/api/workspaces/:workspaceId/members` | member |
| ① | `PATCH` | `/api/workspaces/:workspaceId/members/:userId` | admin — change role |
| ① | `DELETE` | `/api/workspaces/:workspaceId/members/:userId` | admin |
| ① | `PUT` | `/api/workspaces/:workspaceId/deep-work` | member — `{ active, until? }` (D-15) |
| ① | `POST` | `/api/workspaces/:workspaceId/invitations` | admin — **shape pending O-2** |
| ① | `GET` | `/api/workspaces/:workspaceId/audit` | admin — keyset over `audit_log`, newest first (D-26) |
| ② | `PUT` | `/api/workspaces/:workspaceId/retention` | owner — `{ retentionDays: number \| null }`, min 30 (D-27) |
| ② | `POST` | `/api/workspaces/:workspaceId/export` | owner — NDJSON + blobs (D-27) |

Demoting or removing the last `owner` returns `409` (invariant I-2).

---

## 4. Channels

| | Method | Path | Role |
|:-:|---|---|---|
| ○ | `GET` | `/api/workspaces/:workspaceId/channels` | member — channels you can see |
| ○ | `POST` | `/api/workspaces/:workspaceId/channels` | member |
| ○ | `POST` | `/api/workspaces/:workspaceId/dms` | member — `{ userId }`, returns the existing DM or creates it (invariant I-5) |
| ○ | `GET` | `/api/channels/:channelId` | member |
| ① | `PATCH` | `/api/channels/:channelId` | member — name, topic |
| ① | `DELETE` | `/api/channels/:channelId` | admin — soft delete |
| ○ | `POST` | `/api/channels/:channelId/join` | member — public only |
| ① | `POST` | `/api/channels/:channelId/leave` | member |
| ○ | `PUT` | `/api/channels/:channelId/read` | member — `{ lastReadMessageId }` (invariants I-3, I-6) |
| ① | `PUT` | `/api/channels/:channelId/notification-level` | member — `all` \| `mentions` \| `none` |

Creating a DM is idempotent: the same pair returns the same channel, never a second one — and so it is
never a `409`. The call that made the channel answers `201` and tells the other person (`CHANNEL_ADDED`);
every later call for the pair, from either side, answers `200` with the same channel and tells nobody.
A conversation with a person whose account has been erased keeps its channel and its `peer.id`; the
rest of `peer` is a placeholder (`username: "deleted"`, `displayName: "Deleted user"`, no avatar),
because nothing the account held is handed out (I-11).

`PUT …/read` answers the caller's `ChannelState` and, **whether or not the position moved**, publishes it
to the caller's own `user:` topic: a repeat is usually a retry of a read whose answer or frame was
lost, and the frame is the same state, so a client that has it applies it again and one that missed it is
repaired. Nobody else hears it.

---

## 5. Messages & Threads

| | Method | Path | Notes |
|:-:|---|---|---|
| ○ | `GET` | `/api/channels/:channelId/messages` | Root messages, keyset, newest first (`SCHEMA.md` §6.3) |
| ○ | `POST` | `/api/channels/:channelId/messages` | **Fallback when the socket is down.** Same service as `MESSAGE_SEND`. A body with `parentId` is a reply to that root (I-1); the same id in another channel is `404 MESSAGE_NOT_FOUND`, a reply's id is `400` on `parentId`. `@here`, `@channel` and `@everyone` are `400` on `content` (D-12). Content is `MessageContent` in `@purlay/types` — its length limit and the characters it refuses are defined there (D-67) |
| ○ | `GET` | `/api/messages/:messageId/thread` | Replies of a root, keyset, **oldest first** with no cursor or with `after`; `before` reads older ones newest first, as every page does. A reply has no thread: `404` |
| ① | `PATCH` | `/api/messages/:messageId` | Author only — **window pending O-1** |
| ① | `DELETE` | `/api/messages/:messageId` | Author or admin — tombstone, never erase (D-9) |
| ○ | `POST` | `/api/messages/:messageId/resolve` | Roots with at least one reply only, else `409 THREAD_NOT_RESOLVABLE` (I-8). Idempotent: closing a closed thread answers the message and publishes nothing. Answers the root |
| ○ | `DELETE` | `/api/messages/:messageId/resolve` | Reopen; the same message answered, a reply is `409 THREAD_NOT_RESOLVABLE` |
| ○ | `PUT` | `/api/messages/:messageId/reactions/:emoji` | Idempotent. Answers the message's whole set (`ReactionsResponse`) |
| ○ | `DELETE` | `/api/messages/:messageId/reactions/:emoji` | Takes back the caller's own reaction and nobody else's. Idempotent |
| ○ | `GET` | `/api/workspaces/:workspaceId/unresolved` | Open-questions view (`idx_messages_unresolved`): roots with a reply and no resolution, newest first, keyset. **Restricted to channels the caller can see** (D-34) |

A reply, a resolution and a reopening publish `THREAD_UPDATED` after the commit; a reply also moves the
caller-independent counters and tells each recipient their own numbers (`CHANNEL_STATE`, D-99).

**A publish is never the request's error.** The write is committed before anything is published
(D-35), so a frame that cannot be sent is logged with what it was, the rest are still sent, and the
request answers what it did. Re-sending the same message id re-tells everything from the rows as
they are now — the room hears `MESSAGE_CREATED` again, the thread its summary, each recipient their
numbers — and counts nothing twice, so a retry repairs a lost announcement (D-88, D-99 amended).

**Whole-state frames carry a `version`.** `THREAD_UPDATED`, `REACTIONS_UPDATED` and `CHANNEL_STATE` say
"this is the state, replace what you hold", and two of them published from different requests can
arrive in the opposite order to the one their writes committed in. `version` is a positive integer, the
row's own count of its changes taken in the statement that made them (`state_version`, migration
`0015`): a client keeps the newest it has applied for each *thing* (a message's summary, a message's
reactions, a channel's state) and drops a frame with a smaller one. Equal is applied again — it is
the same state told twice. `THREAD_UPDATED` and `REACTIONS_UPDATED` share a message's counter and are
compared only with frames of their own kind.
Every mutation here publishes to the `EventBus`, so an action taken over HTTP reaches other
clients over their sockets identically. HTTP and WebSocket are two doors into one service.

**Reactions** (D-99 §6). `:emoji` is one Unicode emoji, percent-encoded in the path and checked
against the contract's `emoji` format; anything else is `400` naming `emoji`. A message carries at
most **twenty different** emoji: a `PUT` that would add a twenty-first kind is a `400` on `emoji`,
and adding your voice to a kind already there is never refused. A `PUT` of a reaction the caller
already gave, or a `DELETE` of one they never gave, is `200` with the set and **publishes nothing** —
`REACTIONS_UPDATED` is sent, on the channel's topic, only when the set actually changed. A message
that does not exist, is deleted, or is in a channel the caller cannot see is `404 MESSAGE_NOT_FOUND`,
the same answer for all of them.

---

## 6. Search, Notifications, Uploads

| | Method | Path | Notes |
|:-:|---|---|---|
| ① | `GET` | `/api/workspaces/:workspaceId/search` | `?q=` required, `?channelId=` optional, keyset. Substring/identifier match (D-10). **Restricted to channels the caller can see** (D-34) |
| ① | `GET` | `/api/notifications` | `?workspaceId=`, `?unreadOnly=`, keyset |
| ① | `PUT` | `/api/notifications/read` | `{ ids }` or `{ workspaceId, before }` |
| ① | `POST` | `/api/uploads` | `multipart/form-data`. Returns an `attachment.id` with `message_id` still null |
| ① | `GET` | `/api/attachments/:attachmentId` | Brokered download — membership checked, never a public URL |
| ① | `GET` | `/api/attachments/:attachmentId/thumbnail` | Images only |

An upload not attached to a message within 24 hours is swept (`ARCHITECTURE.md` §9).

---

## 7. Integrations

| | Method | Path | Role |
|:-:|---|---|---|
| ① | `GET` | `/api/workspaces/:workspaceId/integrations/github` | admin — never returns the token |
| ① | `PUT` | `/api/workspaces/:workspaceId/integrations/github` | admin — token encrypted at rest |
| ① | `DELETE` | `/api/workspaces/:workspaceId/integrations/github` | admin |
| ① | `POST` | `/api/integrations/github/unfurl` | member — `{ url }` → `GitHubCardMetadata \| null` |
| ② | `POST` | `/api/webhooks/github` | **Unauthenticated by cookie** — verified by HMAC signature instead |

`GET` on the integration returns configuration status only. The encrypted token is never
returned by any endpoint, at any role. (D-23)

---

## 8. Operations

| | Method | Path | Auth |
|:-:|---|---|---|
| ○ | `GET` | `/health` | none — liveness |
| ○ | `GET` | `/health/ready` | none — `200 { status: 'ready' }` when the database answers, every migration is applied and the identifier columns are `COLLATE "C"`; otherwise `503 { status: 'not ready' }`, with the reason in the log only |
| ○ | `GET` | `*` | none — the built client, when `CLIENT_DIST` is set (D-61): a file of the build, or the shell for any other path outside `/api`, `/auth`, `/health` and `/ws`. A missing file with an extension, anything under `/assets`, and every path the API owns are `404 ROUTE_NOT_FOUND`, never HTML. `ETag` and `304`; the shell carries the document's policy (D-102) |
| ○ | `GET` | `/ws` | cookie — WebSocket upgrade (`ARCHITECTURE.md` §7.2) |

Health endpoints expose no version, no dependency detail and no counts — they answer only
"should traffic reach this process".

---

## 9. Adding an endpoint

1. Define the request and response types in `@purlay/types/api.ts` **first**.
2. Add the row to the table above, with its phase marker and required role.
3. Add its cross-tenant case to `apps/api/src/testing/cross-tenant.ts` before the handler —
   or, if it names no workspace, its reason to `UNSCOPED`. Serving it with neither fails the
   build. The case also says whether it names a channel, reads across channels, or neither, and
   that decides its channel-visibility test. (D-21, D-34, D-63, D-64)
4. The handler validates, calls exactly one service, and serializes. No business logic in
   ingress. (`ARCHITECTURE.md` §1)
