# Purlay — HTTP API (`API.md`)

Single source of truth for the HTTP surface. WebSocket frames are specified separately in
`ARCHITECTURE.md` §5.2 — this file covers only HTTP.

The endpoint list previously existed only as scattered mentions across `ARCHITECTURE.md`. It is
consolidated here so that adding an endpoint has one obvious place to be recorded.

**Phase markers:** ○ Phase 0 · ① Phase 1 · ② Phase 2. An endpoint not marked for the current
phase is not built.

---

## 1. Conventions

**Auth.** Every `/api/*` endpoint requires a valid `purlay_session` cookie. There is no bearer
token and no API key in Phase 0–2.

**Tenant scope.** Endpoints under `/api/workspaces/:workspaceId/…` resolve a `WorkspaceContext`
before the handler runs (`ARCHITECTURE.md` §7.3). Endpoints addressing a resource directly
(`/api/channels/:channelId`) derive the workspace from the resource and verify membership.

**404, never 403.** A resource in another workspace returns `404`, because `403` confirms it
exists. This applies to every workspace-scoped route without exception. (D-21)

**Pagination.** Keyset only. `?before=<uuid>` returns older rows, `?after=<uuid>` newer, with
`?limit=` capped at 100 (default 50). `OFFSET` is never accepted. (D-8)

```jsonc
{ "data": [ /* … */ ], "nextCursor": "0199155c-6200-7b7f-…" }  // null when exhausted
```

**Errors.** One shape, always. `code` is a **discriminated union declared in `@purlay/types`** —
stable, machine-readable and exhaustively handleable; adding one breaks any switch that does not
account for it. `message` is for humans and may change. (D-47)

```jsonc
{ "error": { "code": "CHANNEL_NOT_FOUND", "message": "…", "details": {} } }
```

| Status | Meaning |
|---|---|
| `400` | Validation failed — `details` names the fields |
| `401` | No session, or the session is expired or revoked |
| `403` | Authenticated and in the workspace, but the role is insufficient |
| `404` | Does not exist, **or exists in a workspace you are not in** |
| `409` | Conflict — duplicate channel name, duplicate DM, stale edit, or `MESSAGE_ID_CONFLICT` (D-33) |
| `413` | Upload exceeds `attachment_size_limit` |
| `429` | Rate limited |

**Idempotency.** `POST` of a message carries a client-generated UUIDv7 as its `id`. Re-sending
the same id **by the same sender in the same channel** is a no-op that returns the existing
message, so a retry after a timeout can never duplicate. (D-8) The id is validated first — v7
shape and a plausible timestamp — and a collision with somebody else's message returns `409`
without disclosing it. (D-33)

---

## 2. Authentication

| ○ | Method | Path | Notes |
|:-:|---|---|---|
| ○ | `GET` | `/auth/github` | 302 to GitHub, scopes `read:user user:email`. Sets a short-lived signed `state` cookie (D-38) |
| ○ | `GET` | `/auth/github/callback` | Verifies `state`, exchanges the code, resolves identity (D-38), upserts the user, applies open join if configured (D-37), creates a session, 302 to `APP_URL` |

Sign-in refuses with `EMAIL_REQUIRED` when the GitHub account exposes no primary verified email,
and with `ACCOUNT_EMAIL_CONFLICT` when that address already belongs to a different `github_id`.
Neither case is linked silently. (D-38)
| ○ | `POST` | `/auth/logout` | Revokes the current session |
| ① | `POST` | `/auth/logout-all` | Revokes every session for the user |
| ○ | `GET` | `/api/me` | Current user plus workspace memberships |
| ② | `POST` | `/api/me/erase` | Anonymises the account and revokes every session. **Never cascades to messages** (D-27) |

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
| ① | `POST` | `/api/workspaces/:workspaceId/dms` | member — `{ userId }`, returns the existing DM or creates it (invariant I-5) |
| ○ | `GET` | `/api/channels/:channelId` | member |
| ① | `PATCH` | `/api/channels/:channelId` | member — name, topic |
| ① | `DELETE` | `/api/channels/:channelId` | admin — soft delete |
| ○ | `POST` | `/api/channels/:channelId/join` | member — public only |
| ① | `POST` | `/api/channels/:channelId/leave` | member |
| ① | `PUT` | `/api/channels/:channelId/read` | member — `{ lastReadMessageId }` (invariants I-3, I-6) |
| ① | `PUT` | `/api/channels/:channelId/notification-level` | member — `all` \| `mentions` \| `none` |

Creating a DM is idempotent: the same pair returns the same channel, never a second one.

---

## 5. Messages & Threads

| | Method | Path | Notes |
|:-:|---|---|---|
| ○ | `GET` | `/api/channels/:channelId/messages` | Root messages, keyset, newest first (`SCHEMA.md` §6.3) |
| ○ | `POST` | `/api/channels/:channelId/messages` | **Fallback when the socket is down.** Same service as `MESSAGE_SEND` |
| ① | `GET` | `/api/messages/:messageId/thread` | Replies, keyset, oldest first |
| ① | `PATCH` | `/api/messages/:messageId` | Author only — **window pending O-1** |
| ① | `DELETE` | `/api/messages/:messageId` | Author or admin — tombstone, never erase (D-9) |
| ① | `POST` | `/api/messages/:messageId/resolve` | Root messages only |
| ① | `DELETE` | `/api/messages/:messageId/resolve` | Reopen |
| ① | `PUT` | `/api/messages/:messageId/reactions/:emoji` | Idempotent |
| ① | `DELETE` | `/api/messages/:messageId/reactions/:emoji` | |
| ① | `GET` | `/api/workspaces/:workspaceId/unresolved` | Open-questions view (`idx_messages_unresolved`). **Restricted to channels the caller can see** (D-34) |

Every mutation here publishes to the `EventBus`, so an action taken over HTTP reaches other
clients over their sockets identically. HTTP and WebSocket are two doors into one service.

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
| ○ | `GET` | `/health/ready` | none — database reachable and migrations applied |
| ○ | `GET` | `/ws` | cookie — WebSocket upgrade (`ARCHITECTURE.md` §7.2) |

Health endpoints expose no version, no dependency detail and no counts — they answer only
"should traffic reach this process".

---

## 9. Adding an endpoint

1. Define the request and response types in `@purlay/types/api.ts` **first**.
2. Add the row to the table above, with its phase marker and required role.
3. Write the cross-tenant 404 test before the handler. (D-21)
4. The handler validates, calls exactly one service, and serializes. No business logic in
   ingress. (`ARCHITECTURE.md` §1)
