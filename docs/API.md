# Purlay — HTTP API (`API.md`)

Single source of truth for the HTTP surface. WebSocket frames are specified separately in
`ARCHITECTURE.md` §5.2 — this file covers only HTTP.

The endpoint list previously existed only as scattered mentions across `ARCHITECTURE.md`. It is
consolidated here so that adding an endpoint has one obvious place to be recorded.

**Phase markers:** ○ built · ① Phase 1 · ② Phase 2. An endpoint not marked ○ is not built. Rows
pulled forward from a later phase by the owner carry ○ like the rest, and the decision that pulled
them is named in the row.

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
| `403` | Refused for what the caller is, never for what exists: a role that is insufficient (from Phase 1), a member editing a message they did not write, or deleting one without moderating the workspace (D-103), a socket upgrade or a `POST`/`PUT`/`PATCH`/`DELETE` from another origin (D-39, D-80), a GitHub account with no verified address. Never across a tenant or channel boundary — that is `404` |
| `404` | Does not exist, **or exists in a workspace you are not in**, or no such route (`ROUTE_NOT_FOUND`) |
| `409` | Conflict — duplicate workspace slug, duplicate channel name, stale edit, or `MESSAGE_ID_CONFLICT` (D-33). Losing a race for a name is the same `409` as being told it is taken (D-78) |
| `411` | `LENGTH_REQUIRED` — a `POST`/`PUT`/`PATCH`/`DELETE` with a body and no `Content-Length` (chunked): its size cannot be judged before it is read (D-109 §4) |
| `413` | `PAYLOAD_TOO_LARGE` — a JSON body over 64 KiB (`JSON_BODY_MAX_BYTES`, the socket's frame), or an upload over `attachment_size_limit`, refused at the edge by its `Content-Length` before it is read (D-80, D-109 §4) |
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
| ○ | `GET` | `/auth/github/callback` | Verifies `state`, exchanges the code, resolves identity (D-38), upserts the user, applies open join if configured (D-37), creates a session, 302 to `APP_URL`. **Never answers JSON:** a failure is a 302 to the sign-in screen with a reason (below, D-121) |
| ○ | `POST` | `/auth/email` | `EmailSignInRequest` (an address and the language to write in) → `202` whatever the address, so whether an account has it is never said; the message is sent after the answer — a link for an address no account has or an email account's, a word to sign in with GitHub for a GitHub account's, nothing past five an hour. Off without mail configured: `503 EMAIL_SIGN_IN_UNAVAILABLE` (D-138) |
| ○ | `POST` | `/auth/logout` | Revokes the current session, and the devices subscribed in it stop being told (D-126) |
| ○ | `POST` | `/auth/logout-all` | Revokes every session for the user. Phase 0 rather than Phase 1: *sign out everywhere* is the capability D-11 chose database-backed sessions **for**, so shipping the cost without it makes the decision unpaid |
| ○ | `GET` | `/api/me` | Current user, their `profile`, and workspace memberships |
| ○ | `PATCH` | `/api/me/profile` | `{ title?, timeZone?, status? }` (`UpdateProfileRequest`): each left out is kept, `null` clears it, words are trimmed, and nothing but spaces is `400`; a time zone is a named zone the runtime knows, stored as it spells it, else `400` on `timeZone`. Answers the `Profile`. A change sends `WORKSPACE_UPDATED` to everyone in each workspace the caller is in, who read the members again (D-131) |
| ○ | `PUT` | `/api/me/locale` | `{ locale: 'en' \| 'tr' }` (`SetLocaleRequest`) — the language the server writes the caller's notifications in (D-41, D-126); `204` |
| ○ | `GET` | `/api/auth/methods` | Public — `AuthMethods`: whether this server signs in by email as well as by GitHub, so the sign-in screen offers only what works; `email` is false without both of `SMTP_URL` and `MAIL_FROM` (D-138 §6) |
| ○ | `GET` | `/api/push/key` | The server's Web Push public key (`PushKeyResponse`), `null` where push is off — an answer, since every signed-in page asks (D-126) |
| ○ | `POST` | `/api/push/subscriptions` | This device, as its browser's `PushSubscription` gives it, and the caller's language (`PushSubscribeRequest`); `204`. Tied to the caller's live session; an endpoint another person holds moves to the caller only with the same keys, and the answer is the same either way; at most 20 devices a person, the least recently subscribed dropped; a key that is no P-256 point is `400`; `503 PUSH_UNAVAILABLE` where push is off (D-126) |
| ○ | `POST` | `/api/push/subscriptions/remove` | `{ endpoint }` — this device stops being told; `204` whether or not it was the caller's, and another person's stays theirs (D-126) |
| ② | `POST` | `/api/me/erase` | Anonymises the account and revokes every session. **Never cascades to messages** (D-27) |

Sign-in refuses with `EMAIL_REQUIRED` when the GitHub account exposes no primary verified email,
and with `ACCOUNT_EMAIL_CONFLICT` when that address already belongs to a different `github_id`.
Neither case is linked silently. (D-38)

**A refused callback is a redirect, not an error body.** Only a browser GitHub redirected ever
arrives at the callback, so every way it can fail — the rate limit and `INTERNAL` included — answers
`302` to `APP_URL/sign-in?error=<reason>`, spends the `state` cookie and issues no session. The reason
is one of `SignInFailure` in `@purlay/types`, and the address carries nothing else: no code, no
message, nothing GitHub said. The cause is written to the log. (D-121)

| Reason | When |
|---|---|
| `cancelled` | GitHub returned `error=access_denied`: the person pressed Cancel |
| `expired` | `OAUTH_STATE_INVALID` — no state cookie, an expired one, a mismatch, or no `code`; one reason for all of them (D-62) |
| `email-required` | `EMAIL_REQUIRED` |
| `email-taken` | `ACCOUNT_EMAIL_CONFLICT`, including a lost race on the email index |
| `github-unavailable` | GitHub could not be reached, refused, or answered something that is not a usable identity |
| `busy` | `RATE_LIMITED` or `DATABASE_UNAVAILABLE` |
| `failed` | Anything else — another GitHub `error` value, or `INTERNAL` |

Every other route here, `/auth/github` and both logouts included, answers as §1 says.

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
| ○ | `PATCH` | `/api/workspaces/:workspaceId` | admin — `{ name }` (`UpdateWorkspaceRequest`); answers the `Workspace`. The name only: the slug is its address and stays (D-124). The same name is `200` and changes nothing; a member is `403 FORBIDDEN`. On the audit trail with the name before and after; each member's sockets are told `WORKSPACE_UPDATED` and read their memberships again |
| ① | `DELETE` | `/api/workspaces/:workspaceId` | owner — not built |
| ○ | `GET` | `/api/workspaces/:workspaceId/presence` | Member — `PresenceSnapshot`: the members online now on this node, each at its version, and the version everyone else is offline at (D-136). Read when a workspace opens and a grace after a reconnect; `PRESENCE` frames keep it current. Not a member is `404 WORKSPACE_NOT_FOUND` |
| ○ | `GET` | `/api/workspaces/:workspaceId/members` | member — each with their `profile` (D-131) |
| ○ | `PATCH` | `/api/workspaces/:workspaceId/members/:userId` | admin — `{ role }` (`UpdateMemberRoleRequest`); answers the `WorkspaceMember`. An admin manages members and admins; making somebody an owner, or changing an owner, is an owner's (§7.4). A member is `403 FORBIDDEN`; somebody not in the workspace `404 USER_NOT_FOUND`; leaving no owner `409 LAST_OWNER` (I-2) |
| ○ | `DELETE` | `/api/workspaces/:workspaceId/members/:userId` | admin — `204`: out of the workspace and its channels; their sockets are sent `ACCESS_REVOKED` for every channel they could see. An owner is an owner's to remove; the last one `409 LAST_OWNER` (I-2) |
| ○ | `PUT` | `/api/workspaces/:workspaceId/deep-work` | The caller's own — `{ active: true, until }` (ahead, at most `DEEP_WORK_MAX_HOURS`) or `{ active: false }` (`SetDeepWorkRequest`); answers `DeepWorkResponse`. Ends by itself at `until`; each membership in `/api/me` carries `deepWorkUntil`. While it lasts notifications are written `suppressed_by_deep_work` and still counted (D-15, D-108). The person's own sockets are sent `DEEP_WORK_UPDATED` (#526) |
| ○ | `POST` | `/api/workspaces/:workspaceId/invitations` | admin — `201` `CreatedInvitation`: a link valid for `INVITATION_TTL_DAYS`, its `token` in this answer and never again (D-115). A member is `403 FORBIDDEN` |
| ○ | `GET` | `/api/workspaces/:workspaceId/invitations` | admin — `?before=&limit=` (`OlderPageQuery`); an `InvitationPage` of the links that still open, newest first, never their tokens |
| ○ | `DELETE` | `/api/workspaces/:workspaceId/invitations/:invitationId` | admin — `204`: the link stops opening. Revoked or expired already is `204` again; another workspace's is `404 INVITATION_NOT_FOUND` |
| ○ | `POST` | `/api/invitations/preview` | signed in — `{ token }` (`InvitationTokenRequest`); the `InvitationPreview`: which workspace, until when, and whether the caller is in it already |
| ○ | `POST` | `/api/invitations/accept` | signed in — `{ token }`; in as `member`, into no channel, answered with the `Membership`. Already in: the same answer, the role unchanged. A link that does not open — unknown, expired, revoked, its workspace deleted, or the caller removed since it was made — is one `404 INVITATION_NOT_FOUND` |
| ○ | `GET` | `/api/workspaces/:workspaceId/audit` | admin — `?before=&limit=` (`OlderPageQuery`); an `AuditPage` of `AuditEntry`, newest first, keyset on the id (D-26). Who did what to whom, never anything written; a member is `403 FORBIDDEN` |
| ② | `PUT` | `/api/workspaces/:workspaceId/retention` | owner — `{ retentionDays: number \| null }`, min 30 (D-27) |
| ② | `POST` | `/api/workspaces/:workspaceId/export` | owner — NDJSON + blobs (D-27) |

Demoting or removing the last `owner` returns `409` (invariant I-2).

**An invitation's token is never in a path or a query** (D-115): the request log writes every path,
so the token travels in the body, and in the client's address only after `#`, which no request
carries.

---

## 4. Channels

| | Method | Path | Role |
|:-:|---|---|---|
| ○ | `GET` | `/api/workspaces/:workspaceId/channels` | member — channels you can see |
| ○ | `POST` | `/api/workspaces/:workspaceId/channels` | member — `{ name, topic?, type? }`; `type` is `public` (the default) or `private`, seen by its members only (D-104) |
| ○ | `POST` | `/api/workspaces/:workspaceId/conversations` | member — `{ userIds }` (`OpenConversationRequest`): the people besides the caller, one to nine, or the caller alone for a note to self; returns the existing conversation of that set or creates it, `201`/`200` (I-5, D-127). Somebody not a person of the workspace is `404 USER_NOT_FOUND`; the caller among others, a person twice, or more than `CONVERSATION_PEOPLE_MAX` people is `400` |
| ○ | `POST` | `/api/workspaces/:workspaceId/dms` | member — `{ userId }`, returns the existing DM or creates it (invariant I-5) |
| ○ | `GET` | `/api/channels/:channelId` | member |
| ○ | `PATCH` | `/api/channels/:channelId` | member **of the channel** — `{ name?, topic? }` (`UpdateChannelRequest`; a `null` topic clears it), answered with the `Channel`; the room hears `CHANNEL_UPDATED`. A name another live channel of the workspace has, ignoring case, is `409 CHANNEL_NAME_TAKEN`; not in the channel `403 FORBIDDEN`; a direct message `404 CHANNEL_NOT_FOUND`. A rename is on the audit trail; a topic is not (D-123) |
| ○ | `DELETE` | `/api/channels/:channelId` | admin — `204`: archived, a soft delete that keeps its messages and memberships and frees its name. Everyone watching it is sent `ACCESS_REVOKED` with `reason: "archived"`; on the audit trail. A member is `403 FORBIDDEN`; a direct message, or archived already, `404 CHANNEL_NOT_FOUND` (D-123) |
| ○ | `POST` | `/api/channels/:channelId/join` | member — public only |
| ○ | `POST` | `/api/channels/:channelId/members` | a member **of the channel** — `{ userId }`, somebody from the workspace, `204`; they are told with `CHANNEL_ADDED`. Somebody already in it is `204` again, told nothing. Not in the channel, or a direct message: `403 FORBIDDEN`; a person not in the workspace: `404 USER_NOT_FOUND` (D-104) |
| ○ | `POST` | `/api/channels/:channelId/leave` | member — `204`; the caller's sockets are sent `ACCESS_REVOKED` with `reason: "left"`. Not in it is `204` again, told nothing. The last member of a private channel is `409 LAST_CHANNEL_MEMBER`; a direct message `404 CHANNEL_NOT_FOUND` (D-123) |
| ○ | `GET` | `/api/channels/:channelId/members` | member — a `ChannelMemberList`, first to join first; anybody who can see the channel (D-123) |
| ○ | `PUT` | `/api/channels/:channelId/read` | member — `{ lastReadMessageId }` (invariants I-3, I-6) |
| ○ | `PUT` | `/api/channels/:channelId/star` | Member only — stars the channel for the caller. `204`, idempotent. The caller's own row; a channel they are not in, public or not, is `404 CHANNEL_NOT_FOUND`. On the channel as `starred`, false for a non-member. A change sends `CHANNELS_UPDATED` to the caller's own sockets (D-132) |
| ○ | `DELETE` | `/api/channels/:channelId/star` | Member only — lets the caller's star go. `204`, idempotent; `404 CHANNEL_NOT_FOUND` as for `PUT`; `CHANNELS_UPDATED` on a change (D-132) |
| ○ | `PUT` | `/api/channels/:channelId/notification-level` | Member only — `{ level }`, `all` \| `mentions` \| `none` (`SetNotificationLevelRequest`); `204`. The caller's own row; a channel they are not in, public or not, is `404 CHANNEL_NOT_FOUND`. From the next message on; the level is on the channel as `notificationLevel`, null for a non-member (D-107) |

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
| ○ | `GET` | `/api/channels/:channelId/pins` | `PinList`: the channel's pins, newest first, each `PinnedMessage` with who pinned it (null once their account is gone). Never a deleted message's; bounded by `PINS_MAX`, not paged (D-130) |
| ○ | `GET` | `/api/channels/:channelId/files` | `?before=` and `?limit=` (`FileQuery`); `FilePage` of `ChannelFile`: the channel's files, newest message first and then newest file, keyset on both. The cursor is a file's `attachment.id`; one not of this channel's messages is `400` on `before`. Never an unattached upload, never a deleted message's file (D-129) |
| ○ | `POST` | `/api/channels/:channelId/messages` | **Fallback when the socket is down.** Same service as `MESSAGE_SEND`. A body with `parentId` is a reply to that root (I-1); the same id in another channel is `404 MESSAGE_NOT_FOUND`, a reply's id is `400` on `parentId`. `@here`, `@channel` and `@everyone` are `400` on `content` (D-12). Content is `SendContent` in `@purlay/types` — its length limit and the characters it refuses are defined there (D-67). `attachmentIds` (`AttachmentIds`) links the sender's own unattached uploads; any other is `404 ATTACHMENT_NOT_FOUND` and nothing is written. Empty `content` is a message only beside an attachment, otherwise `400` on `content` (D-109 §7) |
| ○ | `GET` | `/api/messages/:messageId/thread` | Replies of a root, keyset, **oldest first** with no cursor or with `after`; `before` reads older ones newest first, as every page does. A reply has no thread: `404` |
| ○ | `GET` | `/api/channels/:channelId/incident` | Anybody who can see the channel — `IncidentResponse`: its open incident, or once none is open its latest; `null` when it never had one, and always for a direct message (D-137) |
| ○ | `POST` | `/api/channels/:channelId/incident` | Channel member — `DeclareIncidentRequest` (the client's UUIDv7 and a severity, 1–4) → `201 Incident`, investigating. The same declaration again is `200` with the incident it made; the id used any other way is `409 INCIDENT_ID_CONFLICT`; one open already, `409 INCIDENT_OPEN`; a visible non-member `403 FORBIDDEN`; a direct message `404 CHANNEL_NOT_FOUND` (D-137 §1, §5) |
| ○ | `PATCH` | `/api/channels/:channelId/incident/:incidentId` | Channel member — `ChangeIncidentRequest` (a status, a severity, a runbook link — `https:` only, or null to clear it — or several) → `Incident`. The runbook may change after it is resolved. The last change wins; the same again changes nothing and tells nobody. A resolved incident changed is `409 INCIDENT_RESOLVED`; another channel's, `404 INCIDENT_NOT_FOUND` (D-137 §3, §5) |
| ○ | `PUT` | `/api/channels/:channelId/incident/:incidentId/postmortem` | Channel member — `SavePostmortemRequest` (the draft, as long as a message may be, and the `postmortemVersion` it was edited from) → `Incident`. One saved since is `409 INCIDENT_POSTMORTEM_CHANGED`, never written over; the same words again change nothing. Allowed after it is resolved (D-137 §3, §5) |
| ○ | `PUT` | `/api/channels/:channelId/incident/:incidentId/responders/:userId` | Channel member — `Incident`: the person brought in to respond, a member of the channel; already responding, nothing changes. Anybody not in the channel is `404 USER_NOT_FOUND`; past `INCIDENT_RESPONDERS_MAX`, `409 INCIDENT_RESPONDERS_LIMIT`. Allowed after it is resolved (D-137 §3) |
| ○ | `DELETE` | `/api/channels/:channelId/incident/:incidentId/responders/:userId` | Channel member — `Incident`: the person taken off; not responding, nothing changes (D-137 §3) |
| ○ | `GET` | `/api/channels/:channelId/incident/:incidentId/updates` | Anybody who can see the channel — `IncidentUpdatePage`: what changed, by whom and when, newest first, keyset on the entry's id (`?before`, `?limit` within `PAGE_LIMIT`) (D-137 §4) |
| ○ | `GET` | `/api/messages/:messageId/versions` | Anybody who can read the message — `MessageVersionPage`: what it said before each edit, newest first, keyset on the version's id (`?before`, `?limit` within `PAGE_LIMIT`); at most `MESSAGE_VERSIONS_KEPT` are kept. A message the caller cannot see, or a deleted one, is `404 MESSAGE_NOT_FOUND` (D-135) |
| ○ | `DELETE` | `/api/messages/:messageId/versions/:versionId` | Author only — `204`: one earlier version taken out of the history, for words edited out that should not be read. Another member is `403 FORBIDDEN`; a version not this message's, or gone already, `404 MESSAGE_VERSION_NOT_FOUND` (D-135 §2) |
| ○ | `PATCH` | `/api/messages/:messageId` | Author only, no window (D-103) — `{ content }` (`EditMessageRequest`), answered with the message as it now is. Another member is `403 FORBIDDEN`; a message the caller cannot see, or a deleted one, `404 MESSAGE_NOT_FOUND`. The same content is not an edit: nothing written, not marked edited. A name the edit adds is told once; nobody already told about the message is told again |
| ○ | `DELETE` | `/api/messages/:messageId` | Author, or a workspace `owner` or `admin` — `204`. The content becomes an empty tombstone, and its earlier versions (D-135 §4), mentions and pin go with it; the row stays (D-9): a root with replies stays in the feed with its thread, a reply stays in its thread, reactions and notifications are kept. What it added to unread and mention counts is taken back. Deleted already is `204` again. Another member is `403 FORBIDDEN` (D-103 §7). Somebody else's message deleted is on the audit trail, by id (D-26) |
| ○ | `POST` | `/api/messages/:messageId/resolve` | Roots with at least one reply only, else `409 THREAD_NOT_RESOLVABLE` (I-8). Idempotent: closing a closed thread answers the message and publishes nothing. Answers the root |
| ○ | `DELETE` | `/api/messages/:messageId/resolve` | Reopen; the same message answered, a reply is `409 THREAD_NOT_RESOLVABLE` |
| ○ | `PUT` | `/api/messages/:messageId/reactions/:emoji` | Idempotent. Answers the message's whole set (`ReactionsResponse`) |
| ○ | `DELETE` | `/api/messages/:messageId/reactions/:emoji` | Takes back the caller's own reaction and nobody else's. Idempotent |
| ○ | `PUT` | `/api/messages/:messageId/pin` | Pins the message for its channel. `204`, idempotent: pinned already, nothing changes and nobody is told. A member's: a visible non-member is `403 FORBIDDEN`; a deleted message is `404`; past `PINS_MAX` pins of messages not deleted in the channel, `409 PINS_LIMIT`. The channel hears `PINS_UPDATED` (D-130) |
| ○ | `DELETE` | `/api/messages/:messageId/pin` | Lets the pin go, a deleted message's included. `204`, idempotent; a member's, as pinning is; the channel hears `PINS_UPDATED` when there was one |
| ○ | `PUT` | `/api/messages/:messageId/saved` | `{ state? }` (`SaveMessageRequest`): saves the message for the caller, or moves its save to `state`; without `state` a new save is `in_progress` and an existing one keeps its state. `204`, idempotent. A deleted message is `404`; past `SAVED_MAX` saves shown in the workspace, a new save is `409 SAVED_LIMIT`. The caller's devices are told `SAVED_UPDATED` (D-128) |
| ○ | `DELETE` | `/api/messages/:messageId/saved` | Lets the caller's save go, a deleted message's included. `204`, idempotent; tells their devices `SAVED_UPDATED` |
| ○ | `GET` | `/api/workspaces/:workspaceId/unresolved` | Open-questions view (`idx_messages_unresolved`): roots with a reply and no resolution, newest first, keyset. **Restricted to channels the caller can see** (D-34) |

A reply, a resolution and a reopening publish `THREAD_UPDATED` after the commit; a reply also moves the
caller-independent counters and tells each recipient their own numbers (`CHANNEL_STATE`, D-99).

**A publish is never the request's error.** The write is committed before anything is published
(D-35), so a frame that cannot be sent is logged with what it was, the rest are still sent, and the
request answers what it did. Re-sending the same message id re-tells everything from the rows as
they are now — the room hears `MESSAGE_CREATED` again, the thread its summary, each recipient their
numbers — and counts nothing twice, so a retry repairs a lost announcement (D-88, D-99 amended).

**Whole-state frames carry a `version`.** `THREAD_UPDATED`, `REACTIONS_UPDATED`, `MESSAGE_REVISED`, `CHANNEL_STATE` and `CHANNEL_UPDATED` (a channel's name and topic, D-123) say
"this is the state, replace what you hold", and two of them published from different requests can
arrive in the opposite order to the one their writes committed in. `version` is a positive integer, the
row's own count of its changes taken in the statement that made them (`state_version`, migration
`0015`, and `0023` for a channel): a client keeps the newest it has applied for each *thing* (a message's summary, a message's
reactions, a message's words, a channel's state, a channel's name) and drops a frame with a smaller one. Equal is applied again — it is
the same state told twice. `THREAD_UPDATED`, `REACTIONS_UPDATED` and `MESSAGE_REVISED` share a message's counter and are
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
| ○ | `GET` | `/api/workspaces/:workspaceId/search` | `?q=` required, trimmed, then `SEARCH_QUERY_MIN`–`SEARCH_QUERY_MAX` characters (`SearchQuery`); `?channelId=` narrows to one channel, `404 CHANNEL_NOT_FOUND` when the caller cannot see it; `?before=` and `?limit=`, newest first (`SearchPage`). The words as typed, ignoring case — `%`, `_` and `\` are literal — in roots and replies, open threads and resolved ones, never a deleted message (D-10, D-105). **Restricted to channels the caller can see** (D-34) |
| ○ | `GET` | `/api/notifications` | `?workspaceId=` required, `?unreadOnly=true\|false`, `?before=` and `?limit=` (`NotificationQuery`); `NotificationPage`, newest first by when the caller was told. The caller's own, from channels they can see now, never about a deleted message (D-106). A workspace they are not in is `404 WORKSPACE_NOT_FOUND`; a `before` that is not one of their notifications there is `400 VALIDATION_FAILED` |
| ○ | `GET` | `/api/workspaces/:workspaceId/saved` | `?state=` required, `?before=` and `?limit=` (`SavedQuery`); `SavedPage`, newest saved first, keyset on the save's id. The caller's own, from channels they can see now, never a deleted message (D-128) |
| ○ | `GET` | `/api/workspaces/:workspaceId/saved/ids` | `SavedIds`: which messages the caller has saved in the workspace, with their channel and state, from channels they can see now. Not paged: bounded by `SAVED_MAX` (D-128) |
| ○ | `PUT` | `/api/notifications/read` | `{ ids }`, or `{ workspaceId, before? }` — everything up to and including `before` (`ReadNotificationsRequest`). `204`, idempotent; ids that are not the caller's are not read and not reported. A workspace they are not in is `404 WORKSPACE_NOT_FOUND`; a `before` that is not one of their notifications there is `400 VALIDATION_FAILED`. Each channel with a notification newly read has its mention badge counted again and is told to the caller's devices as `CHANNEL_STATE` (D-106) |
| ○ | `POST` | `/api/workspaces/:workspaceId/uploads` | `?id=&name=`; the file's raw bytes, `Content-Type: application/octet-stream` (else `415`), `Content-Length` required (`411`) and at most `ATTACHMENT_BYTES_MAX` (`413`) — judged at the edge, before reading. `id` is a client-chosen UUIDv7 (`UploadQuery`): `201` with the `Attachment`, unattached; the same upload again is `200` with the same; the id used otherwise is `409 ATTACHMENT_ID_CONFLICT`. `409 TOO_MANY_PENDING_UPLOADS` past `PENDING_UPLOADS_MAX` unattached; `413 STORAGE_QUOTA_EXCEEDED` past the workspace's quota, unattached uploads counted; `429` when the node is reading `UPLOADS_AT_ONCE` already. Nothing is read before the session and the membership. A PNG, JPEG, GIF or WebP is answered as `kind: "image"`, stored re-encoded as WebP with its stored `width`, `height` and size; one that does not decode is `400 IMAGE_UNREADABLE`, one past the pixel or side bound `413 IMAGE_TOO_LARGE` (D-109 §1, §2, §5) |
| ○ | `DELETE` | `/api/attachments/:attachmentId` | The uploader's own unattached upload (D-109 §5): `204`, the row and its objects gone. Sent, somebody else's or never there: `404 ATTACHMENT_NOT_FOUND` |
| ○ | `GET` | `/api/attachments/:attachmentId` | Brokered download — the uploader while unattached and in the workspace, then whoever can see its message's channel; never a deleted message's (D-109 §6), and anything else is `404 ATTACHMENT_NOT_FOUND`. An image is `inline` as `image/webp`; anything else `attachment` as `application/octet-stream`, the stored type never echoed; always `nosniff`, a `sandbox` CSP, `Cross-Origin-Resource-Policy: same-origin` and `Cache-Control: private, max-age=31536000, immutable` (#111). A row whose object is gone is `500`. Never a public URL |
| ○ | `GET` | `/api/attachments/:attachmentId/thumbnail` | Images only, as the original is read and served; a file's is `404 ATTACHMENT_NOT_FOUND` |
| ○ | `GET` | `/api/images` | Signed in — `?url=` (`ExternalImageQuery`, at most `EXTERNAL_IMAGE_URL_MAX`): an image on another server, fetched by the API and served re-encoded as `image/webp`, with the headers a download has and `Cache-Control: private, max-age=86400` (#110, `docs/spikes/image-proxy.md`). Only `https`, the usual port, a named host; resolved and refused unless every address is public unicast, a fresh connection to the checked address, no redirect, at most `EXTERNAL_IMAGE_BYTES_MAX` and five seconds, decoded within the attachment bounds. **Every failure is one `404 IMAGE_NOT_AVAILABLE`** — refused, unreachable, too large and not an image look the same; the reason is logged with the host alone |

An upload not attached to a message within 24 hours is swept (`ARCHITECTURE.md` §9).

---

## 7. Integrations

| | Method | Path | Role |
|:-:|---|---|---|
| ○ | `GET` | `/api/workspaces/:workspaceId/integrations/github` | admin — `GitHubIntegration`: `{ configured, updatedAt }`; never returns the token. A member is `403 FORBIDDEN` |
| ○ | `PUT` | `/api/workspaces/:workspaceId/integrations/github` | admin — `{ token }` (`SetGitHubTokenRequest`), `204`. Sealed at rest with the one cipher (D-39 §6), recorded in the audit trail without the token |
| ○ | `DELETE` | `/api/workspaces/:workspaceId/integrations/github` | admin — `204`; removing none is `204` too, and records nothing |
| ○ | `POST` | `/api/integrations/github/unfurl` | member — `{ workspaceId, url }` (`UnfurlRequest`; `url` a `GitHubLink`) → `UnfurlResponse`, the `GitHubCardMetadata` or `null`: no token, nothing there, GitHub not answering, or the workspace's calls to GitHub spent for now (D-81). Fetched with the workspace's token and cached for that workspace (D-112) |
| ○ | `GET` | `/api/channels/:channelId/github-feeds` | admin — `GitHubFeedList`: the channel's repository feeds, oldest first, each with its last delivery and last failure; never a secret. Bounded by `GITHUB_FEEDS_PER_CHANNEL_MAX`, not paged. A channel the caller cannot see, or a direct message, is `404 CHANNEL_NOT_FOUND`; a member is `403 FORBIDDEN` (D-134) |
| ○ | `POST` | `/api/channels/:channelId/github-feeds` | admin — `{ repository, events }` (`CreateGitHubFeedRequest`) → `201 CreatedGitHubFeed`: the feed, its `webhookPath` and its `secret`, in this answer only. The same repository again is `409 GITHUB_FEED_EXISTS`, past the cap `409 GITHUB_FEEDS_LIMIT`; recorded in the audit trail with the repository (D-134) |
| ○ | `DELETE` | `/api/channels/:channelId/github-feeds/:feedId` | admin — `204`; a feed not in this channel is `404 GITHUB_FEED_NOT_FOUND`; recorded in the audit trail (D-134) |
| ○ | `POST` | `/api/webhooks/github/:feedId` | **Unauthenticated by cookie** — GitHub's delivery, verified by the feed's HMAC signature instead (`X-Hub-Signature-256`, constant time). `application/json` with a `Content-Length`, at most `WEBHOOK_BODY_MAX_BYTES` (`413`/`411`/`415` at the edge). Answers `WebhookAnswer`: `201` posted, `200` a duplicate, an event the feed does not post or a ping. A feed that is not there, or whose channel is archived, is `404 GITHUB_FEED_NOT_FOUND`; a bad signature `401 WEBHOOK_SIGNATURE_INVALID`; another repository `409 GITHUB_REPOSITORY_MISMATCH`; a body that is not the event `400`; past the buckets `429` (D-134 §4–8) |

`GET` on the integration returns configuration status only. The encrypted token is never
returned by any endpoint, at any role. (D-23)

---

## 8. Operations

| | Method | Path | Auth |
|:-:|---|---|---|
| ○ | `GET` | `/health` | none — liveness |
| ○ | `GET` | `/health/ready` | none — `200 { status: 'ready' }` when the database answers, every migration is applied and the identifier columns are `COLLATE "C"`; otherwise `503 { status: 'not ready' }`, with the reason in the log only |
| ○ | `GET` | `*` | none — the built client, when `CLIENT_DIST` is set (D-61): a file of the build, or the shell for any other path outside `/api`, `/auth`, `/health` and `/ws`, or anything under them, read decoded. A missing file with an extension, anything under `/assets`, and every path the API owns are `404 ROUTE_NOT_FOUND`, never HTML. `ETag` and `304`; the shell carries the document's policy (D-102) |
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
