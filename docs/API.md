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
never accepted. (D-8) A query the route does not know, a parameter given twice, and a `limit` that
is not plain digits (`0x10`, `1e1`, `1.0`, blank) are `400 VALIDATION_FAILED`, never read as a first
page.

**`after` is a cursor, not a watermark** (D-65). A message sent while its author was offline is
accepted up to a minute behind the server clock (D-33) and so can sort *below* the newest id a client
holds; `?after=<newest id>` never returns it. A client that catches up over HTTP for what it may
have missed asks `GET /api/channels/:id/changes` (below), which is ordered by when the server wrote a
message; one that pages the feed with `?after=` for new roots asks from `REPLAY_OVERLAP_MS` before the
newest id's time (the contract bundle's constants carry the number; the socket replay applies it
itself), drops the ids it already holds, and passes each `nextCursor` back as it came.

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
| `401` | No session, or the session is expired or ended (signed out, or revoked) |
| `403` | Refused for what the caller is, never for what exists: a role that is insufficient (from Phase 1), a member editing a message they did not write, or deleting one without moderating the workspace (D-103), a socket upgrade or a `POST`/`PUT`/`PATCH`/`DELETE` from another origin (D-39, D-80), a GitHub account with no verified address is not a `403`: it is the `302` to the sign-in screen with `email-required` (D-121). Never across a tenant or channel boundary — that is `404` |
| `404` | Does not exist, **or exists in a workspace you are not in**, or no such route (`ROUTE_NOT_FOUND`); a `/setup` route to anybody but the setup's holder (`SETUP_UNAVAILABLE`, §2) |
| `409` | Conflict — duplicate workspace slug, duplicate channel name, stale edit, or `MESSAGE_ID_CONFLICT` (D-33). Losing a race for a name is the same `409` as being told it is taken (D-78) |
| `411` | `LENGTH_REQUIRED` — a `POST`/`PUT`/`PATCH`/`DELETE` with a body and no `Content-Length` (chunked): its size cannot be judged before it is read (D-109 §4) |
| `413` | `PAYLOAD_TOO_LARGE` — a JSON body over 64 KiB (`JSON_BODY_MAX_BYTES`, the socket's frame), or an upload over `attachment_size_limit`, refused at the edge by its `Content-Length` before it is read (D-80, D-109 §4). A body past the transport's own cap (`ATTACHMENT_BYTES_MAX`) is refused by the runtime before any of this runs: `413` with **no body and no `x-request-id`** — a client takes the status alone as "too large" |
| `415` | `UNSUPPORTED_MEDIA_TYPE` — a `POST`/`PUT`/`PATCH`/`DELETE` whose body is not `application/json` (a form, `text/plain`, or a body with no type). A request with no body at all, such as logout, is unaffected (D-80) |
| `426` | `CLIENT_TOO_OLD` — an installed client (the macOS app) whose `X-Purlay-Client` header names a wire contract or a version below what this server still serves (`MIN_CLIENT_MACOS_*`, `CONFIG.md`); `details` says the lowest contract and version and where to get a newer one, and the response carries `Upgrade: purlay-client`. Answered at the edge, before the body is read or a session looked up, to every route but `GET /api/client` and `/health*` — and to the socket upgrade, as this status, not as a socket that closes. A header that is not exactly `<platform>/<semver> contract/<n>`, and a browser, which sends none, is served (D-186) |
| `429` | Rate limited (`RATE_LIMITED`), or the setup locked by five wrong codes (`SETUP_LOCKED`, §2) — each with `Retry-After` in whole seconds — the pacing of the budget (one token's refill), not the time left until this caller may try; there are no `RateLimit-*` headers on any answer. A request turned away at the edge (`413`, `415`, `411`, `426`, cross-site `403`) is written to the log under its `x-request-id` like any other |
| `500` | Something the server did not anticipate — `INTERNAL`, carrying no detail of the cause |
| `503` | This process should not receive traffic — `/health/ready` while not ready or draining for shutdown — or, from any endpoint, `DATABASE_UNAVAILABLE`: no database connection within 3 s, or a process that has started and not yet read its settings from the database (D-179 §6); nothing was changed, retry shortly (D-87) |

**Idempotency.** `POST` of a message carries a client-generated UUIDv7 as its `id`. Re-sending
the same id **by the same sender in the same channel** is a no-op that returns the existing
message, so a retry after a timeout can never duplicate. (D-8) The id is validated first — v7
shape and a plausible timestamp — and a collision with somebody else's message returns `409`
without disclosing it. (D-33)

---

## 2. Authentication

| | Method | Path | Notes |
|:-:|---|---|---|
| ○ | `GET` | `/auth/github` | 302 to GitHub, scopes `read:user user:email`, with a PKCE `code_challenge` (`S256`) whose verifier is sent with the code, back to the library's callback `/auth/callback/github` (`SIGN_IN_CALLBACK`, from `APP_URL`). Sets the state's `__Host-purlay_oauth_state` cookie, signed, `Max-Age=300` (the library's five minutes; its server-side row lasts ten), its value kept server-side too (D-38, D-62, D-179). A connect's state, in the same cookie, keeps D-176's ten minutes (`Max-Age=600`). With **no GitHub app connected** (a server in setup mode, D-179 §4) there is no such route: `404 ROUTE_NOT_FOUND`, `GitHub sign-in is not set up on this server.`, in the API's error shape, and no redirect — the sign-in screen does not offer the button then (`AuthMethods.github`), so this is a stale link or a typed address. The library's own `POST /auth/sign-in/social` answers the same, instead of its thrown error; a callback that reaches such a server is a browser, and gets a `302` to the sign-in screen with `?error=expired` |
| ○ | `GET` | `/auth/oidc` | 302 to the organisation's OpenID Connect provider (D-200), its authorization endpoint from its discovery document, with `response_type=code`, `scope=openid email profile`, a `state` (the library's row and `__Host-purlay_oauth_state` cookie, as GitHub's), a `nonce` and a PKCE `code_challenge` (`S256`), back to the library's callback `/auth/callback/oidc` (`OIDC_CALLBACK`, from `APP_URL`). The provider is asked for its discovery document when the button is pressed, never before. With **no provider connected** there is no such route: `404 ROUTE_NOT_FOUND`, `Single sign-on is not set up on this server.`, and no redirect; with one that cannot be discovered (unreachable, another issuer than the one set, an endpoint that is not `https`, no PKCE with S256, nothing it signs with that this server accepts) `502 OIDC_UNAVAILABLE`, no cookie set and nobody redirected. **Charged to the `auth` class per client**, like every `/auth/*` |
| ○ | `GET` | `/auth/*` | The sign-in library's own routes (D-179), under its base path `/auth`, where no route of this table is the same path. Among them **`/auth/callback/oidc`**, which redeems the code with the client secret and the PKCE verifier and believes the `id_token` only whole — signature (JWKS cached and rotated), `iss`, `aud`/`azp`, `exp`, `iat`, `nonce` — then links by a **verified** address or makes the account, as D-200 §3 says, and answers as the next route does; and **`/auth/callback/github`**: verifies the state, exchanges the code, takes GitHub's primary verified address, finds or makes the account (D-38, D-179 §5), creates a session, 302 to `APP_URL`. **Never answers JSON:** a failure is a 302 to the sign-in screen with a reason (below, D-121). A tab whose first sign-up lost to another tab of the same person making the account at that moment is sent round once more, a 302 to `/auth/github` with a `__Host-purlay_signin_retry` marker, so both tabs end signed in (D-78); losing again with the marker is `failed`. `/auth/get-session` reads the session, never extending it. A path the library has no route for is `404 ROUTE_NOT_FOUND`, and so is `/auth/magic-link/verify`, the magic link's own spend: a `GET`, which a mail scanner makes, so a link is spent only by `POST /auth/email/consume` (D-138 §4) |
| ○ | `POST` | `/auth/*` | The sign-in library's own routes, as above: `/auth/sign-out`, `/auth/revoke-session`, `/auth/revoke-sessions`, `/auth/revoke-other-sessions` (ours, by row id, D-179 §3), `/auth/change-password` and `/auth/sign-in/email` (the password routes, below the table), two-step verification's `/auth/two-factor/*` (below the table, D-236), the password reset, and `/auth/sign-in/social`, which answers GitHub's address as JSON rather than redirecting. Password sign-up, `/auth/sign-up/email`, is `400 EMAIL_PASSWORD_SIGN_UP_DISABLED`: nobody makes a password account over HTTP (D-179 §3). Every session one of them ends closes the sockets it held with `SESSION_ENDED { reason: 'signed-out' }` (D-85). Closed, `404`: `/auth/update-user`, `/auth/link-social`, `/auth/unlink-account`, `/auth/get-access-token`, `/auth/refresh-token`, `/auth/account-info`, `/auth/change-email`, `/auth/send-verification-email`, `/auth/verify-email`, `/auth/update-session`, `/auth/delete-user/callback`, `/auth/list-accounts`, `/auth/sign-in/magic-link`, `/auth/request-password-reset`, `/auth/verify-password`, `/auth/delete-user`, `/auth/two-factor/get-totp-uri`, `/auth/two-factor/send-otp`, `/auth/two-factor/verify-otp` — a username is never set by a client, an account is joined to GitHub by one verified address only, no provider token is kept, and a link is asked for only by `POST /auth/email`, under its rules, never with a name of the asker's |
| ○ | `POST` | `/auth/email` | `EmailSignInRequest` (an address, the language to write in, an invitation the tab holds, and the native application's pending `native: {challenge, state}` pair, each carried in the link's fragment) → `202` whatever the address, so whether an account has it is never said — answered once the request is counted, before the account is read or any link made, so neither its words nor its time differ. A link — Better Auth's magic link, mailed as `APP_URL/sign-in/email#<token>[.<invitation>][~<challenge>~<state>]` — goes to an email account's address, a linked one's, and an address no account has only where sign-up is open; a word to sign in with GitHub to an account GitHub made; nothing to an erased account, to an account whose address was never verified (the library would remove its password, D-179 §4), to a new address on an invite-only server, or past five an hour for an address and twenty an hour from a client, counted in the database. Nothing a client sends names the account: a `name`, a `username` or any field the contract does not list is `400 VALIDATION_FAILED`, as is an address the library would refuse. Off without mail configured: `503 EMAIL_SIGN_IN_UNAVAILABLE` (D-138, D-179) |
| ○ | `POST` | `/auth/email/preview` | `EmailSignInToken` → `EmailSignInPreview`, the address the link was sent to, for the page to show before anyone signs in; reads the library's row by the token's digest and spends nothing, so a mail scanner that opens the page signs nobody in. `404 SIGN_IN_LINK_NOT_FOUND` as for consume (D-138 §4) |
| ○ | `POST` | `/auth/email/consume` | `EmailSignInToken` (the token the link carried in its fragment) → `204` with the session cookie: the link is spent once by the library, in one transaction with the session, and an address no account has becomes an account — its address verified, named by D-138 §5 — where sign-up is open. One answer for a link unknown, used or expired, into an account GitHub made, an erased one or one whose address was never verified, or a new account on an invite-only server: `404 SIGN_IN_LINK_NOT_FOUND` (D-138 §2, §4; D-179 §4). An account made by email that GitHub is linked to keeps its link (D-176) |
| ○ | `POST` | `/auth/logout` | Revokes the current session, and the devices subscribed in it stop being told (D-126) |
| ○ | `POST` | `/auth/logout-all` | Revokes every session for the user. Phase 0 rather than Phase 1: *sign out everywhere* is the capability D-11 chose database-backed sessions **for**, so shipping the cost without it makes the decision unpaid |
| ○ | `GET` | `/api/me` | Current user, their `profile`, workspace memberships, `mayCreateWorkspace` — whether `POST /api/workspaces` would let them (D-155) — and `nameFromGitHub`, whether their name is GitHub's and not theirs to set (D-235) |
| ○ | `GET` | `/api/me/sign-in` | `MySignIn` — the caller's own ways in, **read only**: their address, whether the account has a password to change (`hasPassword`), whether a link sent to it signs them in (`emailLinks`: an account made by email, linked to GitHub or not — never one GitHub made, D-138 §2), the GitHub account linked to it, `{ login }` or `null`, and whether single sign-on is linked to it (`oidc`, D-200), and whether a password sign-in asks for a second step (`twoFactor`, D-236). It is what the card *How you sign in* reads; nothing starts a connection from it — GitHub is linked by signing in with it, on one verified address (D-176, D-179 §5) |
| ○ | `GET` | `/api/me/sessions` | `DeviceSessionList` — where the caller is signed in (D-193): each live session of theirs, the one used last first, at most `DEVICE_SESSIONS_MAX`: `{ id, kind: 'browser' \| 'native', name, createdAt, lastUsedAt, expiresAt, current }`. `name` is the native application's device name, `null` for a browser; `lastUsedAt` is precise to the hour (D-60). Never an address, a user agent or anything that could end a session but its own `id`; a lapsed session is not listed |
| ○ | `DELETE` | `/api/me/sessions/:sessionId` | Ends one of the caller's sessions: `204`, its sockets closed with `SESSION_ENDED { reason: 'signed-out' }`. Somebody else's, unknown and already ended are the same `404 SESSION_NOT_FOUND`; a malformed id is `400 VALIDATION_FAILED`. Ending the session the request came in on is signing out of it, without clearing the cookie (`POST /auth/logout` does) |
| ○ | `PATCH` | `/api/me/profile` | `{ title?, timeZone?, status? }` (`UpdateProfileRequest`): each left out is kept, `null` clears it, words are trimmed, and nothing but spaces is `400`; a time zone is a named zone the runtime knows, stored as it spells it, else `400` on `timeZone`. Answers the `Profile`. A change sends `WORKSPACE_UPDATED` to everyone in each workspace the caller is in, who read the members again (D-131). `displayName`, the name shown for the person, trimmed, is taken only where the name is not GitHub's (`nameFromGitHub` on `GET /api/me`); for an account GitHub made, a different one is `400` on `displayName` and the same one changes nothing (D-235) |
| ○ | `PUT` | `/api/me/locale` | `{ locale: 'en' \| 'tr' }` (`SetLocaleRequest`) — the language the server writes the caller's notifications in (D-41, D-126); `204` |
| ○ | `GET` | `/api/me/quiet-hours` | → `QuietHoursSetting`: the caller's quiet hours — `{ from, to, days }`, minutes after midnight and weekdays from Sunday 0, or `null` — and the profile's `timeZone` they are read in (D-234) |
| ○ | `PUT` | `/api/me/quiet-hours` | `SetQuietHoursRequest`, `{ quietHours }` or `{ quietHours: null }` → `QuietHoursSetting`. While they hold, on the profile's clock, what would interrupt the caller is kept and counted and held back as Deep Work holds it. `from` later than `to` runs past midnight. Equal ends, or no time zone on the profile, is `400` on `quietHours` (D-234) |
| ○ | `GET` | `/api/client` | Public — `ClientInfo`, what a client that is not a browser asks before anybody signs in (D-186): `server.version` (the root manifest's, D-185), `contractVersion` (`CONTRACT_VERSION` in `@purlay/types`: the wire contract this server speaks, bumped when an older client would misbehave and never for an addition), optional `capabilities` (`ClientCapabilities`: additive API support, described below), `appUrl` (the canonical `APP_URL`: **the `Origin` the socket upgrade requires**, so a client learns it here and never from what a person typed), `minClient.macos` (`contractVersion`, `appVersion`, `downloadUrl`, each `null` where the operator set no limit) and `auth` (the same `AuthMethods` as below). No session, no database, never cached. Answered to a client too old to be served, since it is how that client learns to update. Charged to the client's address with the sign-in traffic. A client says its version in `X-Purlay-Client: macos/<semver> contract/<n>` on every request and on the socket upgrade |
| ○ | `POST` | `/api/native/authorize` | The signed-in person's browser, once they have said yes to the native application that sent them (D-191, `UX.md` §11): `NativeAuthorizeRequest` — a `challenge` (the application's verifier hashed, base64url, 43 characters) and its own `state` (base64url, 16 to 128 characters, because it is written into a URL) → `200` `NativeAuthorizeResponse`, `{ redirect }`, which is `purlay://auth?code=<64 hex>&state=<state>` — **an address of the server's own and fixed**: the request names none, and a field it does not declare, a `redirect` among them, is `400`. Needs a session, and being a `POST` is refused from any other site by the `Origin` rule (D-80). At most five codes are live for a person at once; a sixth makes the oldest room. The code is shown here and never again: the database keeps its digest |
| ○ | `POST` | `/api/native/token` | **Public — the application has no session yet.** `NativeTokenRequest` — the `code`, the `verifier` it hashed into the challenge and has never sent, and `device.name` (1 to 64 characters, none of them a control or line-breaking one, nor a zero-width or directional one: marks, embeddings, overrides, isolates, the byte-order mark) → `204` with the session cookie, `__Host-purlay_session`, with the usual attributes and `Max-Age`, which the application keeps (a session of its own: signing out ends it, the browser's stays). **One refusal, `404 NATIVE_CODE_NOT_FOUND`, the same bytes for a code nobody made, one spent, expired or burnt, one whose person has been erased, and a wrong verifier.** A wrong verifier does not burn the code until the fifth; a spent code mints nothing and ends nothing. Charged to the client's address before the code is looked at (ten at once, then one every ninety seconds; provisional, O-4) — a `429` inside a code's two minutes means the application starts again, and the address's budget is shared by whoever shares the address — and refused from a browser page by the `Origin` rule. Each refusal is written to the log with its reason (a wrong verifier and a burnt code as warnings), never with the code, its digest, the verifier or the person. The session is labelled `Purlay for macOS/<version> (<device name>)`, the version from `X-Purlay-Client` if it is the shape, else `unknown` |
| ○ | `GET` | `/api/auth/methods` | Public — `AuthMethods`: `{ github: boolean, email: boolean, oidc: { name: string | null } | null, signUp: 'open' | 'invite-only' }`, which of the three ways in this server has connected (`oidc` is `null` where no single sign-on provider is, else the button's label — `null` is the default the client words in the person's language, D-200) and who may make an account, so the sign-in and sign-up screens offer only what works (password sign-in is always offered: the setup's administrator has one). `github` is false until a GitHub app is connected (the settings, D-179 §6); `email` is false without a mail relay (D-138 §6). **None of the three is a server waiting for its setup**, and the screen says so |
| ○ | `GET` | `/api/push/key` | The server's Web Push public key (`PushKeyResponse`), `null` where push is off — an answer, since every signed-in page asks (D-126) |
| ○ | `POST` | `/api/push/subscriptions` | This device, as its browser's `PushSubscription` gives it, and the caller's language (`PushSubscribeRequest`); `204`. Tied to the caller's live session; an endpoint another person holds moves to the caller only with the same keys, and the answer is the same either way; at most 20 devices a person, the least recently subscribed dropped; a key that is no P-256 point is `400`; `503 PUSH_UNAVAILABLE` where push is off (D-126) |
| ○ | `POST` | `/api/push/subscriptions/remove` | `{ endpoint }` — this device stops being told; `204` whether or not it was the caller's, and another person's stays theirs (D-126) |
| ○ | `POST` | `/api/me/erase` | `EraseAccountRequest` — the caller's username, typed — from a session signed in within `ERASURE_SIGN_IN_MINUTES`, else `403 REAUTHENTICATION_REQUIRED`; a wrong username is `400` on `confirm`. `204` with the cookie cleared: the account's personal data is cleared (the address to a placeholder, the name to `deleted-user-…`, the GitHub id and profile), every session revoked and its sockets ended, its devices, pending sign-in links, saved items and notifications deleted, and each workspace told to read its members again; the person's sockets end with `SESSION_ENDED { reason: 'account-deleted' }`. **Never cascades to messages**, reactions or memberships (D-27, I-11). The last live owner of a workspace with another live member is `409 LAST_OWNER` with `details.workspaceIds` naming each to hand over; a workspace left with nobody live in it has its open links revoked (I-2, D-139 §5–§6) |

**The password routes, the library's** (D-179 §4). `POST /auth/sign-in/email`: The library's password sign-in, `{ email, password }` → `200` with the session cookie (`__Host-purlay_session`, the library's session, hashed at rest). **Only the setup's administrator has a password** (D-179 §4); its address may be unverified, and signs in all the same. One answer for an address no account has, an account with no password and a wrong password: `401 INVALID_EMAIL_OR_PASSWORD`, the same body and headers, and the same work — the library hashes the password for an address it does not know (measured, D-179 §4). A password over `PASSWORD_MAX_LENGTH` (128) is `400 PASSWORD_TOO_LONG` before it is hashed or counted; an address the library cannot read `400 INVALID_EMAIL`; a body past the edge's bound `413`. **Throttled on wrong guesses, never locked:** ten for an address from one client and twenty from one client in fifteen minutes — a client being a network, an IPv4 address or an IPv6 /64, counted in the database; past either `429 RATE_LIMITED` with `Retry-After` in seconds, and the password is not weighed, the right one included. A sign-in that works spends nothing. Other clients' wrong guesses never refuse the address from yours. These answers are the library's shape, `{ code, message }`.

`POST /auth/change-password`: `{ currentPassword, newPassword }`, signed in → `200`, **the caller's own session untouched** (the same row, no new cookie); **every other session of the person ends** — deleted by row id, never the caller's, in one statement — whatever `revokeOtherSessions` says, and exactly those sockets close (D-85). Were that step to fail after the password changed, the answer is `500 OTHER_SESSIONS_NOT_ENDED` (the password did change, the other sessions stand; use *Sign out everywhere*). The new password is held to the policy (`passwordProblem` in `@purlay/types`, D-179 §4): `400 PASSWORD_TOO_SHORT` under ten, `400 PASSWORD_TOO_LONG` over 128, `400 PASSWORD_TOO_WEAK` with `reason` — `invalid-character`, `blank`, `contains-email`, `contains-name`, `common` or `repetitive` — said before the current password is weighed. A wrong current password is `400 INVALID_PASSWORD`, counted with the sign-in's wrong guesses for the same address and client, and `429 RATE_LIMITED` with `Retry-After` past them. `/auth/reset-password` holds a new password to the same policy, but no route issues its token: `/auth/request-password-reset` is closed (`404`), as are `/auth/verify-password` and `/auth/delete-user`, the library's other routes that weigh a password, and a password is reset on the server (`bun run admin:reset-password`).


**Two-step verification, the library's** (D-236). For an account with a password; every answer is the library's shape, `{ code, message }`, and none of these routes replaces the caller's session — the same row, no new cookie, no socket told. `POST /auth/two-factor/enable`: `{ password }`, signed in → `200 TwoFactorEnrolment` `{ totpURI, backupCodes }`: an `otpauth://totp/` link whose issuer is `Purlay (<host of APP_URL>)` and the ten backup codes, shown this once; a `method` or `issuer` the client sends is overwritten. Nothing is on yet: the key is kept sealed and unconfirmed. `POST /auth/two-factor/verify-totp` `{ code }`, signed in, turns it on with the first right code (`401 INVALID_CODE` otherwise, any number of tries). Once on, `400 TOTP_ALREADY_ENABLED`. `POST /auth/two-factor/disable` and `POST /auth/two-factor/generate-backup-codes` (`→ BackupCodes`, the old codes spent) take `{ password }`, signed in. A wrong password on any of the three is `400 INVALID_PASSWORD`, counted with the sign-in's wrong guesses for the same address and client, and `429 RATE_LIMITED` with `Retry-After` past them. **At sign-in**, a right password for such an account answers `200 { twoFactorRedirect: true, twoFactorMethods: ['totp'] }` with no session, only `__Host-purlay_two_factor` (signed, `Max-Age=600`); `POST /auth/two-factor/verify-totp` or `/auth/two-factor/verify-backup-code` with `{ code }` and that cookie → `200` with the session cookie, the challenge spent. A wrong code is `401 INVALID_CODE` or `INVALID_BACKUP_CODE`; a sixth try at one challenge `400 TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE` (the password again); no or a spent challenge `401 INVALID_TWO_FACTOR_COOKIE`; ten wrong codes in a row across challenges lock the step for fifteen minutes, `429 ACCOUNT_TEMPORARILY_LOCKED`, the right code included. No device is trusted to skip the step (`trustDevice` is overwritten), and a backup code always opens the session it is spent for. The library also allows three requests to `/auth/two-factor/*` from one client in ten seconds (`429`, `X-Retry-After`). A suspended or erased account gets no session through it (D-233, D-139 §5).

Sign-in refuses when the GitHub account exposes no primary verified email, and when that address
belongs to an account whose own address is unverified — neither is linked (D-38, D-179 §5). An
account made by email whose address **is** verified is the same account, and the sign-in joins
GitHub to it: `github_id` and `github_connected_at` are set and its names stay (D-176 §5–§6). On a
server whose sign-up is invite-only a GitHub account no Purlay account has is refused (D-179 §5).
The username of an account GitHub makes is its login shaped as a mention can name it — lower case,
`[a-z0-9-]`, at most 39 — and the first one free; no client sends one (D-179 §3).

**A refused callback is a redirect, not an error body.** Only a browser GitHub redirected ever
arrives at the callback, so every way it can fail — the rate limit and `INTERNAL` included — answers
`302` to `APP_URL/sign-in?error=<reason>`, spends the `state` cookie and issues no session. The reason
is one of `SignInFailure` in `@purlay/types`, and the address carries nothing else: no code, no
message, nothing GitHub or the sign-in library said. The library's own reasons (its `?error=`) are
each turned into one of these, and one it has never given before is `failed`. The cause is written
to the log. (D-121, D-179)

| Reason | When |
|---|---|
| `cancelled` | GitHub — or the single sign-on provider — returned `error=access_denied`: the person pressed Cancel. Read before the state, so a cancel in another tab is still one |
| `expired` | The state check failed — no state cookie, an expired or spent one, a mismatch — or there is no `code`; one reason for all of them (D-62) |
| `email-required` | No primary verified address on the GitHub account |
| `email-taken` | A local account has the GitHub address but has not verified it, so neither is linked (D-179 §5). The screen's sentence says to sign in by the link sent to that address first where the server sends mail, and to ask an administrator to verify it where it does not |
| `signup-closed` | A GitHub account no Purlay account has, on a server whose sign-up is `invite-only` (D-179 §5) |
| `github-unavailable` | GitHub could not be reached, refused, did not take the code, or answered something that is not a usable identity |
| `oidc-unavailable` | The single sign-on provider could not be reached, refused the code, or sent a token this server does not believe (a signature, issuer, audience, expiry or nonce that is wrong) — the person cannot tell which, and is not told (D-200) |
| `email-unverified` | The single sign-on gave no address, or did not say it is verified (`email_verified` is `true` or the string `"true"`): nothing is made or linked on it (D-200 §3) |
| `busy` | `RATE_LIMITED` or `DATABASE_UNAVAILABLE` |
| `failed` | Anything else — another GitHub `error` value, a reason of the library's nobody anticipated, or `INTERNAL` |

Every other route here, `/auth/github`, `/auth/oidc` and both logouts included, answers as §1 says.

### Additive capabilities for native clients

`GET /api/client` advertises optional API support separately from server releases, the wire-contract
version and minimum-client gates. It is public, identical for authenticated and unauthenticated
callers, database-independent and `Cache-Control: no-store`, including for a client below the
operator's configured minimum. This server includes:

```json
{ "capabilities": { "notificationTypeFilters": true } }
```

`ClientInfo.capabilities` and its known boolean flags are optional, so an older server's handshake
still validates. Only a known flag whose value is exactly `true` confirms support. Missing fields
and `false` do not confirm it; unknown names are ignored, including future values whose shape an
older client does not know. Capability objects stay open to additions; a malformed value for a
known boolean flag is not treated as truthy support.

`notificationTypeFilters: true` means the server accepts the `types` CSV filter on
`GET /api/notifications` as defined in §6. It is always advertised by this implementation because
that query support is available. It does not depend on a workspace role, sign-in provider or user
preference, and does not grant access: the endpoint still requires a live session and workspace/
channel visibility. A future capability must be advertised according to actual API availability.

Clients refresh discovery for the server/connection they are using rather than permanently
inferring support from `server.version` or `contractVersion`. With an older server that does not
advertise the flag, a client may probe the valid read query; for this filter the fallback applies
only to `400 VALIDATION_FAILED` explicitly naming `types`. Authentication, authorization, other
validation errors and network/server failures remain visible. A cached probe result belongs to
that connection session and is discarded when discovering a new connection/server.

This additive field does not bump `CONTRACT_VERSION`, impose a new minimum macOS version or change
release-version policy. Native models regenerate from the deterministic contract bundle, which
carries both `ClientInfo` and `ClientCapabilities`; release versions remain the versions chosen for
the releases themselves (D-185), not feature flags.

### Sign-in through Better Auth, and the setup surface (D-179)

Built: D-179 moved sign-in and sessions to Better Auth and added a browser setup, and every row below
is ○ (built) unless it is marked ①. The library's handler under `/auth` and its GitHub round trip are the ○ rows of §2
above; this section is the surface that code is held to.

**`/auth/*`.** Better Auth's handler is mounted at `/auth`. The contract a browser relies on is the
product's own, unchanged in shape: `POST /auth/email`, `POST /auth/email/preview`,
`POST /auth/email/consume`, `POST /auth/logout`, `POST /auth/logout-all` and the GitHub round trip, with
the token of an email link still only in the fragment and never in a path or a query (D-138 §4), and
every refusal of the round trip still a `302` to the sign-in screen with a reason (D-121). What differs:

| | Method | Path | Notes |
|:-:|---|---|---|
| ○ | `GET` | `/api/auth/methods` | `AuthMethods` says which of GitHub and email are connected (`github`, `email`: built); it gains the sign-up policy, `open` or `invite-only` (`signUp`, built), so the sign-in and sign-up screens offer only what works |

A session is listed or revoked, where a screen needs it, through a route of ours by the session's `id`, never by its token (the database no longer holds one, D-179 §3). Any other route the library offers is outside this contract: it is switched off by configuration or
refused at the edge, and a test holds the list. A client never sends a `username`; one is made from the
GitHub login or the address (D-179 §3).

**`/setup/*`** (built). The setup in the browser (D-179 §4). Not under `/api`: there is no session yet,
and the browser is held by the setup's **claim** instead — a cookie, `__Host-purlay_setup` (`HttpOnly;
Secure; SameSite=Strict; Path=/`, no `Domain`, `Max-Age` 86400: a claim not seen for a day no longer
opens), set by the claim, sent again by every answer to the holder — so it lasts a day from the last
use, as the claim does — and cleared (`Max-Age=0`) by the finish. The functions are
`apps/api/src/ingress/http/setup.ts`; the shapes are `@purlay/types` — the requests in `api.ts`
(`SetupClaimRequest`, `SetupAddressRequest`, `SetupAdminRequest`, `SetupPolicyRequest`,
`SetupGitHubRequest`, `SetupSmtpRequest`, `SetupVerifyRequest`; the workspace's is
`CreateWorkspaceRequest`), the answers in `setup.ts` (`SetupStatus`, `SetupState`, `SetupAdminAnswer`,
`SetupVerifyAnswer`, `ProbeResult`). The steps are `SETUP_STEPS`, taken in order: claim, admin, address,
policy, github, email, workspace, invite, finish.

| | Method | Path | Who | Request → answer |
|:-:|---|---|---|---|
| ○ | `GET` | `/setup/status` | anybody | → `200 SetupStatus` `{ open, appUrl }`, the same for every caller: whether the server is open to setup, and the address it is configured for (`APP_URL`, Ruling R35) — which the page compares with its own origin **before** a code is sent, since a claim from another origin is refused as cross-site. Nothing else — not whether it is claimed, not the step |
| ○ | `POST` | `/setup/claim` | anybody | `{ code }`, the code from the log, any case, dashes or not → `204` and the claim's cookie. The browser's id is the server's to make |
| ○ | `GET` | `/setup/state` | holder | → `200 SetupState`: the steps passed, `appUrl`, `githubCallbackUrl` (`APP_URL/auth/callback/github`), the settings as a view (a secret `{ set }`, the relay as its host), `needsReentry`, `channels` (connected after a try that worked, and serving), `admin` (`name`, `email`, `emailVerified`), `workspace`, `canFinish` and every `finishProblems` |
| ○ | `POST` | `/setup/admin` | holder | `{ name, email, password }` → `200 { signedIn }`: the administrator made, its address unverified, and signed in by the library — its session cookie passed on, **nothing of its body** (which carries the session's raw token). `signedIn: false` is an administrator made and not signed in (the client's wrong-password allowance spent): sign in with the password |
| ○ | `POST` | `/setup/address` | holder | `{ confirmed: true }` → `200`: `APP_URL` seen and confirmed (Ruling R35); it is a deployment setting, never this route's |
| ○ | `POST` | `/setup/policy` | holder | `{ signUp }`, `invite-only` or `open` → `200`: saved and served at once |
| ○ | `POST` | `/setup/github` | holder | `{ clientId, clientSecret, save? }` → `200 ProbeResult`; kept, and served at once, only when `ok` **and** `save`. `{ skip: true }` → `200`, the step passed with nothing connected |
| ○ | `POST` | `/setup/smtp` | holder | `{ smtpUrl, from, allowPlaintext, locale, save? }` → `200 ProbeResult`: the relay tried with the administrator's address letter (a plain test letter, with no link, once the address is verified); kept only when `ok` **and** `save`. `{ skip: true }` → `200`. `{ resend: true, locale }` → `200 ProbeResult`: the same letter sent again through the relay **already kept** — the one thing a browser cannot name, since the relay's address is never shown again — nothing saved, no step passed; refused `409 SETUP_STEP_REFUSED` (`out-of-order`) before the mail step is reached and while no relay is kept (a login the key can no longer open reads as none). Its link replaces the one before; if the relay then refuses, the one before is put back (as it is after a *new* relay is tried and refused), only while the row still holds this letter's link, and letters for a claim go one at a time — so a failed send never leaves the address with no link that opens |
| ○ | `POST` | `/setup/workspace` | holder | `CreateWorkspaceRequest` `{ name, slug }` → `201 Workspace`, the administrator its owner, with `#general` (D-174); asked again, `200` and the one made before, whatever was asked |
| ○ | `POST` | `/setup/invite` | holder | no body → `200`: the invitations sent through the invitation routes of §3 by the signed-in administrator, or skipped |
| ○ | `POST` | `/setup/finish` | holder | no body → `204` and the claim's cookie cleared, when the finish rule holds; the door is closed from then on |
| ○ | `POST` | `/setup/verify` | anybody | `{ token }`, from the fragment of the administrator's link → `200 { verified: true }`. Works in any browser, during the setup and for the link's day after it |

**One answer to everybody without the claim.** A holder route without the cookie, with a wrong one, an
idle one, one taken over by a later code, on a server never claimed, claimed by another browser, or
finished, is `404 SETUP_UNAVAILABLE` — the same body, the same headers, about the same time (a test
measures it). After the finish every `/setup` route answers so, but `GET /setup/status` (`open: false`)
and `POST /setup/verify`. The claim itself tells only what the operator needs: a wrong code — or a right
one past its hour — is `400 VALIDATION_FAILED` on the field `code`; the server's lock after five wrong
codes is `429 SETUP_LOCKED` with `Retry-After` in seconds to its end (a restart, which writes a new
code, ends it); a server closed or claimed is `404 SETUP_UNAVAILABLE`.

**The holder's refusals.**

| Answer | When |
|---|---|
| `400 VALIDATION_FAILED` | A body that does not match its schema; the administrator's `email` (`is not an email address`), `name` (`is one to 128 characters`) or `password`, whose field says the policy's rule by name — `too-short`, `too-long`, `invalid-character`, `blank`, `contains-email`, `contains-name`, `common`, `repetitive` (`passwordProblem`); a relay address (`smtpUrl`: a space or line break, or not `smtp://`/`smtps://` with a host) or sender (`from`: one plain address) that cannot be tried — refused before any letter is made |
| `409 ACCOUNT_EMAIL_CONFLICT` | The administrator's address is an account's already |
| `409 SETUP_STEP_REFUSED` | `details.reason`: `out-of-order` — a step before this one is not passed (checked before anything is tried, so nothing is called or saved); `admin-exists` — a second administrator; `no-workspace` or `no-channel` — the finish, refused (the first reason that holds; `GET /setup/state` lists them all) |
| `500 SETTINGS_CHANGE_FAILED` | A change of the settings did not complete: `details.stage` (`save`, `build`, `verify` — nothing saved, the old settings serve; `commit` — restart the server; `retire` — saved and serving, restart to release the old relay) and `details.restartNeeded`. Never what was in the change |
| `503 DATABASE_UNAVAILABLE` | The server has not read its settings yet, or is shutting down: nothing changed, try again |

**The finish rule** (D-179 §4.5): every step before it passed (the invitations, skipped or not, are the
last), the first workspace there, and at least one way for other people to sign in **connected after a
try that worked and serving now** — a GitHub app GitHub's token endpoint accepted when `save` kept it, or
a relay that took the letter when `save` kept it. An app or a relay only in the settings — seeded from
the environment — does not count. The server enforces it, not only the button.

**`/api/server/*`** (built). Administration → Server (D-179 §4.8): the operator's settings changed in the
browser after the setup, by **the server's administrator** alone (`users.is_server_admin`, Ruling R16 —
a workspace's owner is not one). The functions are `apps/api/src/ingress/http/server.ts`; the shapes are
`@purlay/types` — the requests in `api.ts` (`ServerGitHubRequest`, `ServerSmtpRequest`,
`ServerDisconnectRequest`, `ServerPolicyRequest`, `ServerCreatorsRequest`), the answer in `setup.ts`
(`ServerSettingsAnswer`, `ProbeResult`). A change goes through the wizard's own machinery: tried with the
candidate (`probeGitHub`, `probeSmtp`, under the administrator's authority) and kept and served at once by
`applySettings` only when the try worked. `GET /api/me` says whether the caller is the administrator
(`isServerAdmin`), which is all the client reads to draw Settings → Server.

| | Method | Path | Request → answer |
|:-:|---|---|---|
| ○ | `GET` | `/api/server/settings` | → `200 ServerSettingsAnswer`: `settings` (`signUp`, `github` `{ clientId, clientSecret: { set } }`, `smtp` `{ address: { set, host }, from, allowPlaintext }` — the relay's scheme and host only —, `oidc` `{ issuer, clientId, clientSecret: { set }, name }` — `name` `null` for the default label —, `workspaceCreators`), `needsReentry` (`github`, `smtp`, `oidc`: a sealed secret the current `ENCRYPTION_KEY` cannot open, read as unset), `appUrl`, `githubCallbackUrl`, `oidcCallbackUrl` (what to register as the redirect URI at the provider), `channels` (which ways in serve now: `github`, `email`, `oidc`) and `adminEmail` (the caller's own, where the relay's test letter goes). Never a secret |
| ○ | `POST` | `/api/server/github` | `{ clientId, clientSecret }` → `200 ProbeResult`: GitHub's token endpoint asked with the candidate; kept and served only when `ok`. A try that failed saves nothing |
| ○ | `POST` | `/api/server/oidc` | `{ issuer, clientId, clientSecret, name? }` → `200 ProbeResult`: the provider's discovery document (the issuer in it is the one given, every endpoint `https`, the code flow with PKCE S256), its key set, and the token endpoint sent the candidate's credentials with a code nobody was given (`invalid_grant`: the pair is good; `invalid_client`: the secret is refused); kept and served only when `ok`. An issuer or a name the settings could not hold is `400 VALIDATION_FAILED` before anything is called. The reasons are the closed set, with `issuer-mismatch` and `discovery-invalid` for what only a provider gives (D-200) |
| ○ | `POST` | `/api/server/smtp` | `{ smtpUrl, from, allowPlaintext }` → `200 ProbeResult`: a plain test letter to the **caller's own address** (no link: this is not the proof of an address); kept and served only when `ok` |
| ○ | `DELETE` | `/api/server/github` | optional `{ confirmLastChannel: true }` → `204`: GitHub disconnected — also when its secret could not be opened (`needsReentry`), which clears the unreadable ciphertext. Refused (`409`, below) when it is the last way for other people to sign in, unless `confirmLastChannel` is said |
| ○ | `DELETE` | `/api/server/smtp` | the same, for the mail relay |
| ○ | `DELETE` | `/api/server/oidc` | the same, for single sign-on: accounts it made keep their other ways in, and open sessions stay open |
| ○ | `POST` | `/api/server/policy` | `{ signUp }`, `invite-only` or `open` → `204`, in effect on the next request |
| ○ | `POST` | `/api/server/creators` | `{ workspaceCreators: { kind: 'first' \| 'anyone' } \| { kind: 'listed', logins: [...] } }` → `204`, in effect on the next request. A list is one to a hundred GitHub logins (D-155, D-169), any case, kept lower case; anything else is `400` on `workspaceCreators` |
| ○ | `GET` | `/api/server/accounts` | optional `?q=` (at most `SERVER_ACCOUNT_SEARCH_MAX`) → `200 ServerAccountList`: accounts that are not erased, found by display name, username or address — what is typed is words, never a pattern — ordered by name, at most `SERVER_ACCOUNTS_MAX`. Each says whether it administers the server and when it was suspended, or `null`. Never a credential (D-233) |
| ○ | `PUT` | `/api/server/accounts/:userId/suspension` | → `204`: the account suspended. Every session it had is deleted in the same transaction and each socket is sent `SESSION_ENDED`; it starts no session by any way in and resolves none, until lifted. Memberships, messages and its name stay. Already suspended is `204` again, writing nothing. The caller's own account, or another administrator's, is `403 FORBIDDEN`; erased, never made or not an id, `404 USER_NOT_FOUND`. On the server's trail as `server.account_suspended`, with whose (D-233) |
| ○ | `DELETE` | `/api/server/accounts/:userId/suspension` | → `204`: lifted; the account signs in again as it was. Not suspended is `204` again, writing nothing; on the trail as `server.account_restored` (D-233) |

**Everybody who is not the administrator is `404 ROUTE_NOT_FOUND`** — signed out, a stale cookie, a
member, a workspace's owner, an erased account — the same body and headers (a test compares them):
the route is shaped as absent to everybody it is not for, as `SETUP_UNAVAILABLE` is, so nobody learns from
it that the server has an administration page. (Everywhere else a signed-out `/api` call is `401`; here
it is not, on purpose.) The guard reads `is_server_admin` and `deleted_at` from the database on every
request, so a demotion takes effect at once whatever session is held.

| Answer | When |
|---|---|
| `400 VALIDATION_FAILED` | A body that does not match its schema; a relay address or sender that cannot be tried (`smtpUrl`, `from`, as in the wizard — refused before any letter is made); a list of creators that is not GitHub logins |
| `409 SERVER_CHANGE_REFUSED` | `details.reason`: `last-channel` — the disconnect would leave the administrator's password as the only way in, and `confirmLastChannel` was not said (weighed inside the change's own transaction, so two disconnects at once cannot both pass); `not-connected` — there is nothing of that kind to disconnect (a secret that could not be opened counts as connected, so it can be let go); `setup-unfinished` — the setup in the browser is still open: its steps change the settings until it is finished, and the `tried` bookkeeping the finish rule reads is not touched from here |
| `429 RATE_LIMITED` | More than sixty requests in fifteen minutes (`SERVER_ADMIN_BUDGET`: sixty at once, then one every fifteen seconds) **per client** — counted on every method of every path under `/api/server`, before the session is looked at, so a stranger spends it too |
| `500 SETTINGS_CHANGE_FAILED` | As the wizard's: `details.stage` `save`, `build`, `verify` (nothing saved, the old settings serve), `commit` (restart the server), `retire` (saved and serving; restart to release the old relay). A change whose audit row could not be written is a `save` failure: nothing is saved |
| `503 DATABASE_UNAVAILABLE` | The server has not read its settings yet (`starting`), or is shutting down (`shutting-down`): nothing changed, try again |

Every change is on the **server's own trail** (`server_audit_log`, `SCHEMA.md` §9.1a), written in the
transaction that saves it: who, from which session, and which setting — `server.github_connected`,
`server.github_disconnected`, `server.smtp_connected`, `server.smtp_disconnected`,
`server.sign_up_changed`, `server.workspace_creators_changed` — never the value.

**A failed try is an answer, not an error.** `/setup/github` and `/setup/smtp` answer `200` with a
`ProbeResult`: `ok: true`, or `ok: false` with one `ProbeReason` and `raw`, the service's own reply —
trimmed, at most 200 characters, with every credential that was tried taken out. Both are in
`@purlay/types` (`setup.ts`), the reasons a plain list, `PROBE_REASONS`: `secret-rejected`,
`client-unknown`, `unreachable`, `tls-failed`, `auth-failed`, `sender-refused`, `recipient-refused`,
`message-refused`, `unexpected-reply` — what each means and how each is produced is D-179 §4.4; a
callback address GitHub would refuse is not among them, since only a browser meets that check. The
screen writes what happened and how to correct it from the reason (`UX.md` §11), and shows `raw` **as
text, never as markup** — it is the service's words. **Nothing is saved** on a failure, nor on a try
without `save`. The reply is shown only to the operator who holds the claim.

**The address link.** The `/setup/smtp` try's letter is the administrator's verification letter (D-179
§4.3), whose link is `APP_URL/setup/verify#<token>` — the token in the fragment, so no request line or
referrer carries it. `/setup/verify` is the client's page: it reads the token from the fragment, clears
the fragment, and posts `{ token }` to `POST /setup/verify`. Every link that does not open — unknown,
spent, past its day, its account gone or its address changed since — and every body that is not a
well-formed token (64 hex characters, judged before anything is hashed) is the one answer,
`404 ADMIN_LINK_NOT_FOUND`. A letter that never came is sent again with `{ resend: true }` on `/setup/smtp` (§2): the newest link is the only one that opens, and a resend the relay refuses leaves the last working one in place.

**Limits and the edge.** Every `/setup` route is limited per client — an IPv4 address or an IPv6 /64
(`limitKeyFor`) — and the limit is charged before the claim is looked at or anything is weighed:
`POST /setup/claim` and `POST /setup/verify` ten in fifteen minutes (`SETUP_SECRET_BUDGET`), every
holder route thirty in fifteen minutes (`SETUP_BUDGET`), and `GET /setup/status` with the sign-in
traffic (`AUTH_BUDGET`); a `HEAD` is charged as the `GET` it runs; past one, `429 RATE_LIMITED` with
`Retry-After`. The server's own lock on wrong
codes stays, and is the server's; the limit per client is what keeps one client from holding it shut.
A `POST` from another origin is `403 FORBIDDEN` before anything else (D-39), a body that is not JSON
`415`, over 64 KiB `413`. Every `/setup` answer is `Cache-Control: no-store` and `X-Robots-Tag: noindex`.

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
| ○ | `POST` | `/api/workspaces` | Whom the server's setting names (D-179 §6, seeded once from `WORKSPACE_CREATORS`) — GitHub logins, or anybody; by default only the first person to sign in, while the instance has no workspace (D-155). Anybody else is `403 FORBIDDEN` and nothing is made. The creator becomes `owner`, and the workspace starts with one public channel, `general`, with no topic and the creator in it — made in the same transaction, on the trail as `channel.created` (D-174) |
| ○ | `GET` | `/api/workspaces/:workspaceId` | member |
| ○ | `PATCH` | `/api/workspaces/:workspaceId` | admin — `{ name }` (`UpdateWorkspaceRequest`); answers the `Workspace`. The name only: the slug is its address and stays (D-124). The same name is `200` and changes nothing; a member is `403 FORBIDDEN`. On the audit trail with the name before and after; each member's sockets are told `WORKSPACE_UPDATED` and read their memberships again |
| ① | `DELETE` | `/api/workspaces/:workspaceId` | owner — not built |
| ○ | `GET` | `/api/workspaces/:workspaceId/presence` | Member — `PresenceSnapshot`: the members online now on this node, each at its version, and the version everyone else is offline at (D-136). Read when a workspace opens and a grace after a reconnect; `PRESENCE` frames keep it current. Not a member is `404 WORKSPACE_NOT_FOUND` |
| ○ | `GET` | `/api/workspaces/:workspaceId/members` | member — each with their `profile` (D-131) |
| ○ | `PATCH` | `/api/workspaces/:workspaceId/members/:userId` | admin — `{ role }` (`UpdateMemberRoleRequest`); answers the `WorkspaceMember`. An admin manages members and admins; making somebody an owner, or changing an owner, is an owner's (§7.4). A member is `403 FORBIDDEN`; somebody not in the workspace `404 USER_NOT_FOUND`; leaving no owner `409 LAST_OWNER` (I-2) |
| ○ | `DELETE` | `/api/workspaces/:workspaceId/members/:userId` | admin — `204`: out of the workspace and its channels; their sockets are sent `ACCESS_REVOKED` for every channel they could see. An owner is an owner's to remove; the last one `409 LAST_OWNER` (I-2) |
| ○ | `DELETE` | `/api/workspaces/:workspaceId/membership` | member — the caller leaves the workspace and every channel in it (D-152); answers `204`, recorded as `member.left`, and the caller's own sockets are told (`ACCESS_REVOKED`). The last owner is `409 LAST_OWNER` (I-2): make somebody else an owner first. Somebody not in the workspace is `404 WORKSPACE_NOT_FOUND`; signed out `401` |
| ○ | `PUT` | `/api/workspaces/:workspaceId/deep-work` | The caller's own — `{ active: true, until }` (ahead, at most `DEEP_WORK_MAX_HOURS`) or `{ active: false }` (`SetDeepWorkRequest`); answers `DeepWorkResponse`. Ends by itself at `until`; each membership in `/api/me` carries `deepWorkUntil`. While it lasts notifications are written `suppressed_by_deep_work` and still counted (D-15, D-108). The person's own sockets are sent `DEEP_WORK_UPDATED` (#526) |
| ○ | `POST` | `/api/workspaces/:workspaceId/invitations` | admin — optional body `CreateInvitationRequest` `{ emails?, locale? }`, empty as it always could be. `201` `CreatedInvitation`: a link valid for `INVITATION_TTL_DAYS`, its `token` in this answer and never again (D-115). **With `emails`** (at most `INVITATION_EMAILS_PER_REQUEST`, twenty — more is `400 VALIDATION_FAILED` before anything is made; `locale` is `en` or `tr`, default `en`) the answer also carries `mail`: one `{ address, outcome }` for each address, in order, a repeat in any case dropped first. The one link — never one for each address, no role, no address bound to it — is mailed to every address whose outcome is `queued`, **after the answer, once the transaction has committed**: `queued` means the letter is waiting to be handed to the mail server, not that it was, nor that it arrived — a send that then fails is logged by its code, never told, which is why the link is in the answer too. The other outcomes are refusals made before anything was queued: `invalid` (not one mailbox, as `/auth/email` reads an address), `inviter_limit` (`INVITATION_EMAILS_PER_INVITER_PER_DAY`, fifty a day for the caller across workspaces), `workspace_limit` (`INVITATION_EMAILS_PER_WORKSPACE_PER_DAY`, two hundred a day for the workspace, whoever asks), `unavailable` (this server has no mail relay). A day opens at the first letter and closes a day later; both counts are in the database (`rate_limits`) and a request that fails gives back what it took. Whether an address already belongs to a member is not looked up and not said — members' addresses are not shown to each other. A member is `403 FORBIDDEN`; another workspace's admin is `404 WORKSPACE_NOT_FOUND` |
| ○ | `GET` | `/api/workspaces/:workspaceId/invitations` | admin — `?before=&limit=` (`OlderPageQuery`); an `InvitationPage` of the links that still open, newest first, never their tokens |
| ○ | `DELETE` | `/api/workspaces/:workspaceId/invitations/:invitationId` | admin — `204`: the link stops opening. Revoked or expired already is `204` again; another workspace's is `404 INVITATION_NOT_FOUND` |
| ○ | `POST` | `/api/invitations/preview` | signed in — `{ token }` (`InvitationTokenRequest`); the `InvitationPreview`: which workspace, until when, and whether the caller is in it already |
| ○ | `POST` | `/api/invitations/passport` | public, `{ token, email? }` (`InvitationPassportRequest`), charged per client (10 at once, then one every 90 s; a 429 with `Retry-After`) — what lets a newcomer make an account on an invite-only server (D-179 §5). Without `email` it sets the cookie `__Host-purlay_invite=<random>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600` for the GitHub sign-in that follows; with it, the pass is for that address and the mailed link, and no cookie is set. `204` either way, never saying whether an address has an account. A link that does not open is the preview's one `404 INVITATION_NOT_FOUND`; an address that is not one, `400 VALIDATION_FAILED`; a link already holding twenty live passports, `429 RATE_LIMITED`. One hour, one use |
| ○ | `POST` | `/api/invitations/accept` | signed in — `{ token }`; in as `member`, into no channel, answered with the `Membership`. Already in: the same answer, the role unchanged. A link that does not open — unknown, expired, revoked, its workspace deleted, or the caller removed since it was made — is one `404 INVITATION_NOT_FOUND` |
| ○ | `GET` | `/api/workspaces/:workspaceId/audit` | admin — `?before=&limit=&actorId=&action=&from=&to=` (`AuditQuery`); an `AuditPage` of `AuditEntry`, newest first, keyset on the id (D-26). Who did what to whom, never anything written. Narrowed on the server (D-222): `actorId` who acted, `action` one of `AUDIT_ACTIONS`, `from` (inclusive) and `to` (exclusive) instants with their zone — the client turns the reader's days into them; `nextCursor` pages within the filter. A `to` not after `from`, or a day that does not exist, is `400 VALIDATION_FAILED` naming the field; another workspace's person is simply nobody here. A member is `403 FORBIDDEN` |
| ○ | `GET` | `/api/workspaces/:workspaceId/audit/export` | admin — `?format=csv\|ndjson` and the filter of the row above (`AuditExportQuery`): every entry it keeps, newest first, as an attachment (`<slug>-audit-<day>.<format>`) — one `AuditExportLine` per line of NDJSON, or a CSV (UTF-8 with a byte-order mark, CRLF) whose header is `AUDIT_EXPORT_COLUMNS` and whose `metadata` cell is JSON; a cell that would start a formula (`=`, `+`, `-`, `@`, tab, carriage return) is prefixed with `'`. Streamed a page at a time, so its size is unbounded and its memory is not. Recorded as `audit.exported` with the format and the filter before the first byte; a refused filter is refused before (D-222). A database failing before the first byte is `500 INTERNAL`; after it, the download is cut off, never ended as if whole. A member is `403 FORBIDDEN` |
| ○ | `GET` | `/api/workspaces/:workspaceId/retention` | owner — `RetentionSetting`: how many days of history the workspace keeps, `null` for forever (the default), and `channelsKeptLonger`, how many of its channels — archived and private ones included — keep longer than that (D-225); a count, never which. Its own route, since the `Workspace` shape is shown to people not yet in it (D-139 §4) |
| ○ | `GET` | `/api/workspaces/:workspaceId/storage` | owner — `StorageUsage`: the bytes the workspace's files take — those sent and the uploads waiting to be — and its quota, counted as an upload is checked, so the two never disagree. The quota is the operator's to set (`bun run storage:quota`, `CONFIG.md`), never through this API (D-173) |
| ○ | `PUT` | `/api/workspaces/:workspaceId/retention` | owner — `SetRetentionRequest`, whole days from `RETENTION_DAYS_MIN` (the table's own check) to `RETENTION_DAYS_MAX`, or `null` for forever; answers the `RetentionSetting`. A change is on the trail as `retention.changed` with what it was and what it became; the same window again writes nothing. The nightly purge does the rest (D-27, D-139) |
| ○ | `POST` | `/api/workspaces/:workspaceId/exports` | owner — `202` with the `WorkspaceExport`, made in the background: the channels the owner can see (every public one, and the private ones and direct messages they are in), NDJSON per table plus the files, as one `.tar`, without anybody's address. One at a time a workspace: `409 EXPORT_IN_PROGRESS` (D-27, D-140) |
| ○ | `GET` | `/api/workspaces/:workspaceId/exports` | owner — the newest ten `WorkspaceExport`s the caller asked for — an export holds what its asker can see, so another owner's is not listed: being made, ready (its size, until when), failed (a code), downloaded or expired (D-140) |
| ○ | `GET` | `/api/workspaces/:workspaceId/exports/:exportId/download` | owner, the one who asked — the archive, `application/x-tar`, **once**: the download claims it, and a second — at once or later, or after it expired — is `404 EXPORT_NOT_FOUND`. It leaves the store once served; a ready one nobody downloads goes after `EXPORT_KEPT_HOURS` (`sweep:exports`) (D-140) |

Demoting or removing the last `owner` returns `409` (invariant I-2).

**An invitation's token is never in a path or a query** (D-115): the request log writes every path,
so the token travels in the body, and in the client's address only after `#`, which no request
carries.

---

## 4. Channels

| | Method | Path | Role |
|:-:|---|---|---|
| ○ | `GET` | `/api/workspaces/:workspaceId/channels` | member — channels you can see, each a `Channel` as the caller sees it; every one carries `memberCount`, its members whose account is not erased, joined or not, read in the list's one statement (D-167), and `codeRepository`, its one GitHub feed's repository or null with none or several, which its messages' code references link into (D-223) |
| ○ | `GET` | `/api/workspaces/:workspaceId/archived-channels` | admin — `ArchivedChannelList`: the archived channels the caller may bring back, the most recently archived first, at most `ARCHIVED_CHANNELS_MAX`: every public one, and a private one only to a member of it. Name, type and when; nothing of what is in them. A member is `403 FORBIDDEN` (D-232) |
| ○ | `POST` | `/api/workspaces/:workspaceId/channels` | member — `{ name, topic?, type? }`; `type` is `public` (the default) or `private`, seen by its members only (D-104). The maker's other devices are told with `CHANNEL_ADDED` (#540) |
| ○ | `POST` | `/api/workspaces/:workspaceId/conversations` | member — `{ userIds }` (`OpenConversationRequest`): the people besides the caller, one to nine, or the caller alone for a note to self; returns the existing conversation of that set or creates it, `201`/`200` (I-5, D-127). Somebody not a person of the workspace is `404 USER_NOT_FOUND`; the caller among others, a person twice, or more than `CONVERSATION_PEOPLE_MAX` people is `400` |
| ○ | `POST` | `/api/workspaces/:workspaceId/dms` | member — `{ userId }`, returns the existing DM or creates it (invariant I-5) |
| ○ | `GET` | `/api/channels/:channelId` | member |
| ○ | `PATCH` | `/api/channels/:channelId` | member **of the channel** — `{ name?, topic? }` (`UpdateChannelRequest`; a `null` topic clears it), answered with the `Channel`; the room hears `CHANNEL_UPDATED`. A name another live channel of the workspace has, ignoring case, is `409 CHANNEL_NAME_TAKEN`; not in the channel `403 NOT_A_CHANNEL_MEMBER`; a direct message `404 CHANNEL_NOT_FOUND`. A rename is on the audit trail; a topic is not (D-123) |
| ○ | `GET` | `/api/channels/:channelId/retention` | owner — `ChannelRetention`: what the channel keeps beyond its workspace (`keepsAtLeast`: `null` the workspace's window, `"forever"`, or at least so many days), the workspace's window, and `effectiveDays`, what the purge keeps — the longer of the two, `null` for everything. An admin or a member is `403 FORBIDDEN`; a direct message `404 CHANNEL_NOT_FOUND` (D-225) |
| ○ | `PUT` | `/api/channels/:channelId/retention` | owner — `SetChannelRetentionRequest`, `{ keepsAtLeast }` as above, days from `RETENTION_DAYS_MIN` to `RETENTION_DAYS_MAX`; answers the `ChannelRetention`. **Only longer**: days fewer than the workspace keeps now, or any number while it keeps everything, is `409 RETENTION_TOO_SHORT`; a workspace window lengthened past the channel's later wins. A change is on the trail as `channel.retention_changed` with what it was and what it became (`workspace`, `forever` or days); the same setting again writes nothing and is answered as set, whatever the workspace keeps now. No frame: only an owner reads it. An admin or a member is `403 FORBIDDEN`; a direct message, or archived, `404 CHANNEL_NOT_FOUND` (D-225) |
| ○ | `DELETE` | `/api/channels/:channelId` | admin — `204`: archived, a soft delete that keeps its messages and memberships and frees its name. Everyone watching it is sent `ACCESS_REVOKED` with `reason: "archived"`; on the audit trail. A member is `403 FORBIDDEN`; a direct message, or archived already, `404 CHANNEL_NOT_FOUND` (D-123) |
| ○ | `POST` | `/api/channels/:channelId/join` | member — public only. The person's other devices are told with `CHANNEL_ADDED` when this call is what joined it, as leaving tells them with `ACCESS_REVOKED`; a second join is told nothing (#540) |
| ○ | `POST` | `/api/channels/:channelId/members` | a member **of the channel** — `{ userId }`, somebody from the workspace, `204`; they are told with `CHANNEL_ADDED`. Somebody already in it is `204` again, told nothing. Not in the channel: `403 NOT_A_CHANNEL_MEMBER`; a direct message: `403 FORBIDDEN`; a person not in the workspace: `404 USER_NOT_FOUND` (D-104) |
| ○ | `POST` | `/api/channels/:channelId/restore` | admin — `204`: an archived channel back as it was, its messages and memberships kept. Each member is sent `CHANNELS_UPDATED` on their own topic; on the audit trail as `channel.restored`. Its name taken by a live channel since, in any case, is `409 CHANNEL_NAME_TAKEN`. A member is `403 FORBIDDEN`; a live channel, a direct message, a private one the caller is not in, another workspace's, or not an id, `404 CHANNEL_NOT_FOUND` (D-232) |
| ○ | `POST` | `/api/channels/:channelId/leave` | member — `204`; the caller's sockets are sent `ACCESS_REVOKED` with `reason: "left"`. Not in it is `204` again, told nothing. The last member of a private channel is `409 LAST_CHANNEL_MEMBER`; a direct message `404 CHANNEL_NOT_FOUND` (D-123) |
| ○ | `DELETE` | `/api/channels/:channelId/members/:userId` | admin, or a member **of a private channel** for another whose role is `member` — `204`: the person is out, their sockets sent `ACCESS_REVOKED` with `reason: "removed"`, their messages kept; on the audit trail as `channel.member_removed`. An owner is an owner's to take out; a member of a public channel takes out nobody: `403 FORBIDDEN`. Not in it is `204` again, told nothing; somebody not in the workspace `404 USER_NOT_FOUND`. Naming yourself is leaving (`POST …/leave`, its answers and `reason: "left"`); the last member of a private channel `409 LAST_CHANNEL_MEMBER`; a direct message or a group `404 CHANNEL_NOT_FOUND` (D-172) |
| ○ | `GET` | `/api/channels/:channelId/members` | member — a `ChannelMemberList`, first to join first; anybody who can see the channel (D-123) |
| ○ | `PUT` | `/api/channels/:channelId/read` | member — `{ lastReadMessageId }` (invariants I-3, I-6). Reads the feed: the notifications of the roots at or behind it. A reply's waits for its thread (`PUT …/thread/read`) or the inbox, and stays unread until then (D-147) |
| ○ | `PUT` | `/api/channels/:channelId/unread` | member — `{ fromMessageId }`. "Mark unread from here" (D-212): the position moves back to just before the message (a reply marks its root), both counters recounted from the rows; the one backwards move, and none when it is already unread from there. Notifications are not touched. `MESSAGE_NOT_FOUND` for a message of another channel |
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
| ○ | `GET` | `/api/channels/:channelId/changes` | Anybody who can read the channel's history, refused as it is (D-194). What happened to its messages since a client last heard: with no parameter, `{ data: [], nextCursor: null, asOf }` — the watermark, the server's clock; `?since=<asOf>` the first page, `?after=<cursor>` the next, **never both** (`400`), `?limit=` as for history. `ChangePage`: `data` the messages as they now stand — roots **and replies**, a deleted one as its tombstone, oldest change first (a change is the instant the server wrote the row, never its id's order: a message that arrived late under an old id, an edit, a deletion, a reaction added or taken back, a reply, a resolved thread, a redaction); `nextCursor` null on the last page; `asOf` the same on every page of one walk — a client keeps it and asks `since` it once the walk is drained. A walk reaches `CHANGES_OVERLAP_MS` behind `since`, so a message may be told again: keep messages by id and discard what is held. A cursor that this server did not make, an unknown query or a repeated parameter is `400 VALIDATION_FAILED`. Pins, memberships, the channel list and the inbox are not in it, and neither is a message the retention purge has deleted (D-139 §3, D-194): there is no row left to carry |
| ○ | `GET` | `/api/channels/:channelId/files` | `?before=` and `?limit=` (`FileQuery`); `FilePage` of `ChannelFile`: the channel's files, newest message first and then newest file, keyset on both. The cursor is a file's `attachment.id`; one not of this channel's messages is `400` on `before`. Never an unattached upload, never a deleted message's file (D-129) |
| ○ | `POST` | `/api/channels/:channelId/messages` | **Fallback when the socket is down.** Same service as `MESSAGE_SEND`. A member's: somebody who can see the channel and is not in it — a public channel they have not joined — is `403 NOT_A_CHANNEL_MEMBER`, a message and a reply alike, and nothing is written (D-156). A body with `parentId` is a reply to that root (I-1); the same id in another channel is `404 MESSAGE_NOT_FOUND`, a reply's id is `400` on `parentId`. `@here`, `@channel` and `@everyone` are `400` on `content` (D-12). Content is `SendContent` in `@purlay/types` — its length limit and the characters it refuses are defined there (D-67). `attachmentIds` (`AttachmentIds`) links the sender's own unattached uploads; any other is `404 ATTACHMENT_NOT_FOUND` and nothing is written. Empty `content` is a message only beside an attachment, otherwise `400` on `content` (D-109 §7) |
| ○ | `GET` | `/api/messages/:messageId` | Anybody who can read the message — the `Message`, for a card a link to it is drawn as (D-217): a forwarded message, a link pasted. Deleted, never sent, or not the caller's to see: `404 MESSAGE_NOT_FOUND` (D-34) |
| ○ | `GET` | `/api/messages/:messageId/around` | Anybody who can read the message — `MessageWindow`: the feed around it, for a link to it. `target` is the message; `data` the root it lives under (itself, or a reply's root) with up to `MESSAGE_WINDOW_SIDE` roots either side, newest first; `olderCursor` continues as `before`, `newerCursor` as `after`, each null once that end is in it. Deleted, never sent, or not the caller's to see: `404 MESSAGE_NOT_FOUND` (D-149) |
| ○ | `GET` | `/api/messages/:messageId/thread` | Replies of a root, keyset, **oldest first** with no cursor or with `after`; `before` reads older ones newest first, as every page does. A reply has no thread: `404` |
| ○ | `PUT` | `/api/messages/:messageId/thread/read` | Anybody who can see the root — `{ lastReadMessageId }` (`ReadThreadRequest`), the newest reply the person has seen; `204`, idempotent. Reads the caller's notifications for this thread's replies up to and including it — the channel's read position does not (D-147) — and tells each channel with one newly read to the caller's devices as `CHANNEL_STATE`, as the inbox does. Nothing is stored but that, so a bound behind an earlier one changes nothing. A reply has no thread: `404 MESSAGE_NOT_FOUND`, as for one the caller cannot see |
| ○ | `GET` | `/api/messages/:messageId/follow` | Anybody who can see the root — `ThreadFollow` `{ following }`: whether the caller is told of new replies in this thread. Without a choice of their own, they follow a thread they started or have answered (D-29); with one, it is what they chose (D-161). A reply has no thread: `404 MESSAGE_NOT_FOUND`, as for one the caller cannot see |
| ○ | `PUT` | `/api/messages/:messageId/follow` | Anybody who can see the root, a member or not — the caller's own, as a save is (D-156 §3) — `{ following }` (`SetThreadFollowRequest`); answers `ThreadFollow`, idempotent. Kept until they choose again: replying does not follow a thread let go again. Moves only the thread's reasons — `thread_reply`, and a reply's `channel_message` at level `all` — never a mention or a direct message; a channel at `none` stays silent. From the next reply on, told to nobody (D-161). A reply: `404 MESSAGE_NOT_FOUND` |
| ○ | `GET` | `/api/channels/:channelId/incident` | Anybody who can see the channel — `IncidentResponse`: its open incident, or once none is open its latest; `null` when it never had one, and always for a direct message (D-137) |
| ○ | `POST` | `/api/channels/:channelId/incident` | Channel member — `DeclareIncidentRequest` (the client's UUIDv7 and a severity, 1–4) → `201 Incident`, investigating. The same declaration again is `200` with the incident it made; the id used any other way is `409 INCIDENT_ID_CONFLICT`; one open already, `409 INCIDENT_OPEN`; a visible non-member `403 NOT_A_CHANNEL_MEMBER`; a direct message `404 CHANNEL_NOT_FOUND` (D-137 §1, §5) |
| ○ | `PATCH` | `/api/channels/:channelId/incident/:incidentId` | Channel member — `ChangeIncidentRequest` (a status, a severity, a runbook link — `https:` only, or null to clear it — or several) → `Incident`. The runbook may change after it is resolved. A visible non-member is `403 NOT_A_CHANNEL_MEMBER`, here and on the postmortem and the responders. The last change wins; the same again changes nothing and tells nobody. A resolved incident changed is `409 INCIDENT_RESOLVED`; another channel's, `404 INCIDENT_NOT_FOUND` (D-137 §3, §5) |
| ○ | `PUT` | `/api/channels/:channelId/incident/:incidentId/postmortem` | Channel member — `SavePostmortemRequest` (the draft, as long as a message may be, and the `postmortemVersion` it was edited from) → `Incident`. One saved since is `409 INCIDENT_POSTMORTEM_CHANGED`, never written over; the same words again change nothing. Allowed after it is resolved (D-137 §3, §5) |
| ○ | `PUT` | `/api/channels/:channelId/incident/:incidentId/responders/:userId` | Channel member — `Incident`: the person brought in to respond, a member of the channel; already responding, nothing changes. Anybody not in the channel is `404 USER_NOT_FOUND`; past `INCIDENT_RESPONDERS_MAX`, `409 INCIDENT_RESPONDERS_LIMIT`. Allowed after it is resolved (D-137 §3) |
| ○ | `DELETE` | `/api/channels/:channelId/incident/:incidentId/responders/:userId` | Channel member — `Incident`: the person taken off; not responding, nothing changes (D-137 §3) |
| ○ | `GET` | `/api/channels/:channelId/incident/:incidentId/updates` | Anybody who can see the channel — `IncidentUpdatePage`: what changed, by whom and when, newest first, keyset on the entry's id (`?before`, `?limit` within `PAGE_LIMIT`) (D-137 §4) |
| ○ | `GET` | `/api/messages/:messageId/versions` | Anybody who can read the message — `MessageVersionPage`: what it said before each edit, newest first, keyset on the version's id (`?before`, `?limit` within `PAGE_LIMIT`); at most `MESSAGE_VERSIONS_KEPT` are kept. A message the caller cannot see, or a deleted one, is `404 MESSAGE_NOT_FOUND` (D-135) |
| ○ | `DELETE` | `/api/messages/:messageId/versions/:versionId` | Author only — `204`: one earlier version taken out of the history, for words edited out that should not be read. Another member is `403 FORBIDDEN`; a version not this message's, or gone already, `404 MESSAGE_VERSION_NOT_FOUND` (D-135 §2) |
| ○ | `PATCH` | `/api/messages/:messageId` | Author only, no window (D-103), and while in the channel (D-156) — `{ content }` (`EditMessageRequest`), answered with the message as it now is. Another member is `403 FORBIDDEN`; an author no longer in it, `403 NOT_A_CHANNEL_MEMBER` — deleting their own stays theirs; a message the caller cannot see, or a deleted one, `404 MESSAGE_NOT_FOUND`. The same content is not an edit: nothing written, not marked edited. A name the edit adds is told once; nobody already told about the message is told again |
| ○ | `DELETE` | `/api/messages/:messageId` | Author, or a workspace `owner` or `admin` — `204`. The content becomes an empty tombstone, and its earlier versions (D-135 §4), mentions and pin go with it; the row stays (D-9): a root with replies stays in the feed with its thread, a reply stays in its thread, reactions and notifications are kept. What it added to unread and mention counts is taken back. Deleted already is `204` again. Another member is `403 FORBIDDEN` (D-103 §7). Somebody else's message deleted is on the audit trail, by id (D-26) |
| ○ | `POST` | `/api/messages/:messageId/resolve` | A member's: a visible non-member is `403 NOT_A_CHANNEL_MEMBER` (D-156). Roots with at least one reply only, else `409 THREAD_NOT_RESOLVABLE` (I-8). Idempotent: closing a closed thread answers the message and publishes nothing. Answers the root |
| ○ | `DELETE` | `/api/messages/:messageId/resolve` | Reopen, a member's as resolving is; the same message answered, a reply is `409 THREAD_NOT_RESOLVABLE` |
| ○ | `PUT` | `/api/messages/:messageId/knowledge` | Current channel members only, roots only; `SetKnowledgeRequest` carries version, isQuestion, assigneeId, acceptedAnswerId, decisionNote and decisionUrl. A selected answer must be a live reply of this root; assignment must be a current channel member. An identical retry succeeds; stale changed input is 409 KNOWLEDGE_CONFLICT. Answers Message and publishes THREAD_UPDATED after commit, without notifications (D-204). |
| ○ | `PUT` | `/api/messages/:messageId/reactions/:emoji` | A member's: a visible non-member is `403 NOT_A_CHANNEL_MEMBER` (D-156). Idempotent. Answers the message's whole set (`ReactionsResponse`) |
| ○ | `DELETE` | `/api/messages/:messageId/reactions/:emoji` | Takes back the caller's own reaction and nobody else's. Idempotent |
| ○ | `GET` | `/api/channels/:channelId/bookmarks` | Anybody who can see the channel — `BookmarkList`: its links kept at hand, oldest first, at most `BOOKMARKS_MAX` (D-218) |
| ○ | `POST` | `/api/channels/:channelId/bookmarks` | member — `{ url, title }`, `http`/`https` only: `201` with the `ChannelBookmark`; the same address again is the same bookmark, unchanged. `409 BOOKMARKS_LIMIT` past `BOOKMARKS_MAX`. Tells the channel `BOOKMARKS_UPDATED` (D-218) |
| ○ | `DELETE` | `/api/channels/:channelId/bookmarks/:bookmarkId` | member — `204`; a bookmark not this channel's is `404 BOOKMARK_NOT_FOUND`. Tells the channel `BOOKMARKS_UPDATED` (D-218) |
| ○ | `PUT` | `/api/messages/:messageId/pin` | Pins the message for its channel. `204`, idempotent: pinned already, nothing changes and nobody is told. A member's: a visible non-member is `403 NOT_A_CHANNEL_MEMBER`; a deleted message is `404`; past `PINS_MAX` pins of messages not deleted in the channel, `409 PINS_LIMIT`. The channel hears `PINS_UPDATED` (D-130) |
| ○ | `DELETE` | `/api/messages/:messageId/pin` | Lets the pin go, a deleted message's included. `204`, idempotent; a member's, as pinning is; the channel hears `PINS_UPDATED` when there was one |
| ○ | `PUT` | `/api/messages/:messageId/saved` | `{ state? }` (`SaveMessageRequest`): saves the message for the caller, or moves its save to `state`; without `state` a new save is `in_progress` and an existing one keeps its state. `204`, idempotent. A deleted message is `404`; past `SAVED_MAX` saves shown in the workspace, a new save is `409 SAVED_LIMIT`. The caller's devices are told `SAVED_UPDATED` (D-128) |
| ○ | `DELETE` | `/api/messages/:messageId/saved` | Lets the caller's save go, a deleted message's included. `204`, idempotent; tells their devices `SAVED_UPDATED` |
| ○ | `GET` | `/api/workspaces/:workspaceId/unresolved` | Unresolved roots with replies or explicitly marked questions, including zero replies (D-204). Visible channels only; optional `channelId`, `unanswered=yes`, `assigneeId`, `order=oldest` or `newest`. `before` is the continuation cursor in the chosen ordering; `after` retains forward replay. Keyset pagination, no deleted roots. |

A reply, a resolution and a reopening publish `THREAD_UPDATED` after the commit; a reply also moves the
caller-independent counters and tells each recipient their own numbers (`CHANNEL_STATE`, D-99). A send,
an edit or a resolution that writes somebody a notification then tells them `NOTIFICATIONS_UPDATED` on
their own topic, whether or not a counter of theirs moved (D-106).

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
| ○ | `GET` | `/api/workspaces/:workspaceId/search` | `SearchQuery`: required `q`, empty only with a filter, otherwise trimmed literal text of SEARCH_QUERY_MIN–SEARCH_QUERY_MAX characters; `channelId`, `senderId`, `status=open/resolved`, `question=yes`, `kind=code/file`, inclusive `since` and exclusive `until` timestamps, and exact `repository=owner/repo`. Newest first, `before` UUID and `limit`. Matches message text, decision notes and live selected answers. Visible channels only; inaccessible channel filter is 404. `SearchPage` (D-204). |
| ○ | `GET` | `/api/workspaces/:workspaceId/saved-searches` | The caller’s own named filters in this workspace, newest UUID first, `OlderPageQuery` and `SavedSearchPage`. No cached results (D-204). |
| ○ | `PUT` | `/api/workspaces/:workspaceId/saved-searches/:searchId` | Saves or replaces the caller’s filter at a client-chosen UUID. `SaveSearchRequest`, answers SavedSearch. At most SAVED_SEARCH_LIMIT; another person’s id is 404 SAVED_SEARCH_NOT_FOUND. Writes serialized under the membership lock (D-204). |
| ○ | `DELETE` | `/api/workspaces/:workspaceId/saved-searches/:searchId` | Removes only the caller’s save in this workspace; idempotent 204 (D-204). |
| ○ | `GET` | `/api/notifications` | `?workspaceId=` required, optional `?types=mention` or `?types=thread_reply,thread_resolved` (one CSV value, `NotificationTypesFilter`), `?unreadOnly=true\|false`, `?before=` and `?limit=` (`NotificationQuery`); `NotificationPage`, newest first by when the caller was told. The caller's own, from channels they can see now, never about a deleted message (D-106). A reply's notification carries its thread in brief — `thread: { rootId, excerpt, authorId }` (`NotificationThread`): the root's text plain on one line, at most `THREAD_EXCERPT_MAX` characters, null when the root is deleted or has no words; null for anything that is not a reply — read in the same statement as the page (D-162). A workspace they are not in is `404 WORKSPACE_NOT_FOUND`; a `before` that is not one of their notifications there is `400 VALIDATION_FAILED` |
| ○ | `GET` | `/api/workspaces/:workspaceId/saved` | `?state=` required, `?before=` and `?limit=` (`SavedQuery`); `SavedPage`, newest saved first, keyset on the save's id. The caller's own, from channels they can see now, never a deleted message (D-128) |
| ○ | `GET` | `/api/workspaces/:workspaceId/saved/ids` | `SavedIds`: which messages the caller has saved in the workspace, with their channel and state, from channels they can see now. Not paged: bounded by `SAVED_MAX` (D-128) |
| ○ | `PUT` | `/api/notifications/read` | `{ ids }`, or `{ workspaceId, before? }` — everything up to and including `before` (`ReadNotificationsRequest`). `204`, idempotent; ids that are not the caller's are not read and not reported. A workspace they are not in is `404 WORKSPACE_NOT_FOUND`; a `before` that is not one of their notifications there is `400 VALIDATION_FAILED`. Each channel with a notification newly read has its mention badge counted again and is told to the caller's devices as `CHANNEL_STATE` (D-106) |
| ○ | `POST` | `/api/workspaces/:workspaceId/uploads` | `?id=&name=`; the file's raw bytes, `Content-Type: application/octet-stream` (else `415`), `Content-Length` required (`411`) and at most `ATTACHMENT_BYTES_MAX` (`413`) — judged at the edge, before reading. `id` is a client-chosen UUIDv7 (`UploadQuery`): `201` with the `Attachment`, unattached; the same upload again is `200` with the same; the id used otherwise is `409 ATTACHMENT_ID_CONFLICT`. `409 TOO_MANY_PENDING_UPLOADS` past `PENDING_UPLOADS_MAX` unattached; `413 STORAGE_QUOTA_EXCEEDED` past the workspace's quota, unattached uploads counted, with `details.remainingBytes` — the room left, never below zero (`StorageQuotaDetails`, D-159); `429` when the node is reading `UPLOADS_AT_ONCE` already. Nothing is read before the session and the membership. A PNG, JPEG, GIF or WebP is answered as `kind: "image"`, stored re-encoded as WebP with its stored `width`, `height` and size; one that does not decode is `400 IMAGE_UNREADABLE`, one past the pixel or side bound `413 IMAGE_TOO_LARGE` (D-109 §1, §2, §5) |
| ○ | `DELETE` | `/api/attachments/:attachmentId` | The uploader's own unattached upload (D-109 §5): `204`, the row and its objects gone. Sent, somebody else's or never there: `404 ATTACHMENT_NOT_FOUND` |
| ○ | `GET` | `/api/attachments/:attachmentId` | Brokered download — the uploader while unattached and in the workspace, then whoever can see its message's channel; never a deleted message's (D-109 §6), and anything else is `404 ATTACHMENT_NOT_FOUND`. An image is `inline` as `image/webp`; anything else `attachment` as `application/octet-stream`, the stored type never echoed; always `nosniff`, a `sandbox` CSP, `Cross-Origin-Resource-Policy: same-origin` and `Cache-Control: private, no-cache` with an `ETag`: a kept copy is asked about, and `If-None-Match` is answered `304` only once access is checked again (D-231 §3). A row whose object is gone is `500`. Never a public URL |
| ○ | `GET` | `/api/attachments/:attachmentId/thumbnail` | Images only, as the original is read and served; a file's is `404 ATTACHMENT_NOT_FOUND` |
| ○ | `GET` | `/api/images` | Signed in — `?url=` (`ExternalImageQuery`, at most `EXTERNAL_IMAGE_URL_MAX`): an image on another server, fetched by the API and served re-encoded as `image/webp`, with the headers a download has and `Cache-Control: private, max-age=86400` (#110, `docs/spikes/image-proxy.md`). Only `https`, the usual port, a named host; resolved and refused unless every address is public unicast, a fresh connection to the checked address, no redirect, at most `EXTERNAL_IMAGE_BYTES_MAX` and five seconds, decoded within the attachment bounds. **Every failure is one `404 IMAGE_NOT_AVAILABLE`** — refused, unreachable, too large and not an image look the same; the reason is logged with the host alone |

An upload not attached to a message within 24 hours is swept (`ARCHITECTURE.md` §9).

---

### Notification type filters

`GET /api/notifications` accepts one optional `types` query value: a comma-separated, case-sensitive
list of distinct `NotificationType` values, with no whitespace or empty items. The shared
`NotificationTypesFilter` schema defines its bound and pattern. Empty values, duplicate/unknown
values, arrays and repeated query keys are `400 VALIDATION_FAILED`, naming the offending query
field. A request without `types` retains the existing behavior, including `channel_message` and
subsequently supported notification types.

Examples (replace the UUIDs with the caller's workspace and notification IDs):

```text
/api/notifications?workspaceId=0199155c-6200-7b7f-8c11-2a4d3f9e1b70
/api/notifications?workspaceId=0199155c-6200-7b7f-8c11-2a4d3f9e1b70&types=mention&unreadOnly=true
/api/notifications?workspaceId=0199155c-6200-7b7f-8c11-2a4d3f9e1b70&types=direct_message&limit=25
/api/notifications?workspaceId=0199155c-6200-7b7f-8c11-2a4d3f9e1b70&types=thread_reply%2Cthread_resolved&limit=25
/api/notifications?workspaceId=0199155c-6200-7b7f-8c11-2a4d3f9e1b70&types=channel_message&unreadOnly=false
```

Mentions, DMs and Threads select the stored notification reasons `mention`, `direct_message` and
`thread_reply,thread_resolved`, respectively. They do not reclassify a notification by the kind or
location of its message. All omits the parameter rather than enumerating the current reasons.

Recipient, workspace, current channel visibility, deleted-message, type and unread predicates all
apply in SQL before pagination. Pages retain the descending total order `(created_at, message_id,
notification_id)` and database timestamp precision. `nextCursor` is the last returned matching
notification's ID only if another matching row exists; otherwise it is null. A caller's own
notification in the same workspace can anchor the order even when its type/read state is outside
the current filter or its target message is deleted. Another recipient's/workspace's cursor, or an
unknown cursor, remains a validation refusal. An inaccessible workspace remains `404` before type
validation, and a signed-out request remains `401`.

When a client changes workspace, type selection or All/Unread, it starts a new page sequence and
uses a distinct cache key; an old cursor must not be appended to that sequence. This is a live
keyset traversal, not a snapshot of records/read state across concurrent changes.

This query does not change notification generation, delivery preferences, badges or read actions.
`PUT /api/notifications/read { workspaceId }` still marks that workspace's notifications read across
all types; `{ ids }` reads only the supplied notifications. Neither write accepts `types`. Category
counts are a separate feature; the mention badge's `NEEDS_YOU` reasons exclude `thread_resolved`.
Native clients regenerate from the updated deterministic contract bundle; the parameter is a
schema-validated string with CSV contents, so no implicit array serializer or new custom format
is required.

## 7. Integrations

| | Method | Path | Role |
|:-:|---|---|---|
| ○ | `GET` | `/api/workspaces/:workspaceId/integrations/github` | admin — `GitHubIntegration`: `{ configured, updatedAt }`; never returns the token. A member is `403 FORBIDDEN` |
| ○ | `PUT` | `/api/workspaces/:workspaceId/integrations/github` | admin — `{ token }` (`SetGitHubTokenRequest`), `204`. Sealed at rest with the one cipher (D-39 §6), recorded in the audit trail without the token |
| ○ | `DELETE` | `/api/workspaces/:workspaceId/integrations/github` | admin — `204`; removing none is `204` too, and records nothing |
| ○ | `POST` | `/api/integrations/github/unfurl` | member — `{ workspaceId, url }` (`UnfurlRequest`; `url` a `GitHubLink`) → `UnfurlResponse`, the `GitHubCardMetadata` or `null`: no token, nothing there, GitHub not answering, or the workspace's calls to GitHub spent for now (D-81). Fetched with the workspace's token and cached for that workspace (D-112) |
| ○ | `GET` | `/api/channels/:channelId/github-feeds` | admin — `GitHubFeedList`: the channel's repository feeds, oldest first, each with its last delivery and last failure; never a secret. Bounded by `GITHUB_FEEDS_PER_CHANNEL_MAX`, not paged. A channel the caller cannot see, or a direct message, is `404 CHANNEL_NOT_FOUND`; a member is `403 FORBIDDEN` (D-134) |
| ○ | `POST` | `/api/channels/:channelId/github-feeds` | admin — `{ repository, events }` (`CreateGitHubFeedRequest`) → `201 CreatedGitHubFeed`: the feed, its `webhookPath` and its `secret`, in this answer only. The same repository again is `409 GITHUB_FEED_EXISTS`, past the cap `409 GITHUB_FEEDS_LIMIT`; recorded in the audit trail with the repository and the channel (D-134, #691) |
| ○ | `DELETE` | `/api/channels/:channelId/github-feeds/:feedId` | admin — `204`; a feed not in this channel is `404 GITHUB_FEED_NOT_FOUND`; recorded in the audit trail with the repository and the channel (D-134, #691) |
| ○ | `POST` | `/api/webhooks/github/:feedId` | **Unauthenticated by cookie** — GitHub's delivery, verified by the feed's HMAC signature instead (`X-Hub-Signature-256`, constant time). `application/json` with a `Content-Length`, at most `WEBHOOK_BODY_MAX_BYTES` (`413`/`411`/`415` at the edge). Answers `WebhookAnswer`: `201` posted, `200` a duplicate, an event the feed does not post or a ping. A feed that is not there, or whose channel is archived, is `404 GITHUB_FEED_NOT_FOUND`; a bad signature `401 WEBHOOK_SIGNATURE_INVALID`; another repository `409 GITHUB_REPOSITORY_MISMATCH`; a body that is not the event `400`; past the buckets `429` (D-134 §4–8) |

`GET` on the integration returns configuration status only. The encrypted token is never
returned by any endpoint, at any role. (D-23)

---

## 8. Operations

| | Method | Path | Auth |
|:-:|---|---|---|
| ○ | `GET` | `/health` | none — liveness |
| ○ | `GET` | `/health/ready` | none — `200 { status: 'ready' }` when the database answers, every migration is applied and the identifier columns are `COLLATE "C"` — and, where `REDIS_URL` is set, Redis has been reached since the process started (a Redis lost afterwards is degraded service, not unready: D-201); otherwise `503 { status: 'not ready' }`, with the reason in the log only |
| ○ | `GET` | `/metrics` | `Authorization: Bearer <METRICS_TOKEN>` — this process's counts in Prometheus's text format 0.0.4 (`text/plain; version=0.0.4`, `no-store`; D-221): its uptime and memory, open sockets, every HTTP request as a histogram by method, route **as registered** (`/api/channels/:channelId`; `/*` for whatever the catch-all took, `(edge)` for a request turned away before routing, `(unmatched)` for a method no route takes) and status class, what was refused for the rate at each door, push and mail failures, and the scheduled jobs' last success and failures since. No label carries a path as sent, an id, an address, a name or anything written. **Without `METRICS_TOKEN`, without the token, or with another, it is `404 ROUTE_NOT_FOUND` exactly as a path nothing serves** (`CONFIG.md`); the production proxy answers it `404` itself |
| ○ | `GET` | `*` | none — the built client, when `CLIENT_DIST` is set (D-61): a file of the build, or the shell for any other path outside `/api`, `/auth`, `/health`, `/metrics` and `/ws`, or anything under them, read decoded. A missing file with an extension, anything under `/assets`, and every path the API owns are `404 ROUTE_NOT_FOUND`, never HTML. `ETag` and `304`; the shell carries the document's policy (D-102), whose images are this origin's alone (D-237) |
| ○ | `GET` | `/ws` | cookie — WebSocket upgrade (`ARCHITECTURE.md` §7.2) |

Health endpoints expose no version, no dependency detail and no counts — they answer only
"should traffic reach this process". Counts are `/metrics`'s, behind its token (D-221).

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
