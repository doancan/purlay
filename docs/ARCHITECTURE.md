# Purlay — Architecture (`ARCHITECTURE.md`)

> Authority: `DECISIONS.md` is binding on *why*; `SCHEMA.md` is binding on *what is stored*.
> This file is binding on *how the parts fit together*.

---

## 1. Tenets

1. **End-to-end type safety.** HTTP contracts, WebSocket frames and database rows all derive
   from `@purlay/types`. A shape defined in two places will diverge; there are none.
2. **The network is never in the way.** The UI renders from local state and reconciles
   afterwards. Nothing blocks on a round-trip. (D-17)
3. **Protocols are adapters, not architecture.** Business rules live in service modules. HTTP
   and WebSocket are two thin ingress adapters over the same services — swapping or adding one
   must not touch a service.
4. **Tenant isolation is a type, not a discipline.** Workspace-scoped repositories take a
   `WorkspaceContext` they cannot construct themselves. Forgetting the filter is a compile
   error, not a code-review catch. (§7)
5. **Choose boring where it is not the point.** One PostgreSQL, one process, no broker. New
   infrastructure must be forced by a measurement. (D-7)

---

## 2. Stack

| Layer | Choice | Cost we accepted |
|---|---|---|
| Monorepo | Bun workspaces + Turborepo | Turborepo config is another thing to maintain |
| Logging | `pino` | Named here because §10 mandates structured JSON logging and no document named the tool (D-44) |
| i18n | typed message catalogues + `Intl` | No library: two catalogues to keep in step by hand, in exchange for keeping the 250 KB budget (D-41) |
| Runtime | Bun 1.4+ | Young ecosystem; fewer battle-tested libraries; fewer managed hosts |
| HTTP + WS | ElysiaJS | Smaller community than Express/Fastify; docs move fast. **The highest-risk choice now that the cloud carries an uptime commitment** — Hono is the written fallback with a four-week trigger (D-20) |
| Database | PostgreSQL 18 | Latest stable major (2025-09, supported to 2030-11). Ships a native `uuidv7()` we deliberately do not use — D-8 needs the id client-side |
| Query builder | Kysely | No migration tooling and no relation loading; we write SQL and joins by hand |
| Validation | TypeBox | Shared with Elysia's schema layer, so one definition validates and types |
| Web | React 19 + Vite, single-page with a **prerendered shell** | Cold load is met by shipping less, not by rendering elsewhere; server rendering would fight the optimistic model (D-50) |
| UI primitives | Radix, for dialog · menu · combobox · tooltip · popover only | One package per primitive so only what is used ships; everything else is written here (D-52) |
| Component tests | `bun test` + `happy-dom` + Testing Library | Two tools with two jobs — logic and accessibility here, browser behaviour in Playwright |
| Browser tests | Playwright + `@axe-core/playwright` | Keyboard paths, visual snapshots and the cold-load measurement. Snapshot maintenance is a real cost, accepted (D-52) |
| Styling | Tailwind CSS | Verbose markup; arbitrary values prohibited, extend the theme instead |
| Server state | TanStack Query | (D-18) |
| Realtime state | Zustand | (D-18) |
| Object storage | S3-compatible (MinIO local) | An extra service locally; filesystem driver exists for simple self-hosts |
| Server markdown | `unified` / `remark` + sanitising serialiser | Server-only, so no bundle cost; a large dependency tree to audit (D-36) |
| Client markdown | a small CommonMark/GFM renderer | Two parsers to keep aligned; a shared fixture suite is the guard (D-36) |
| Highlighting | Shiki, grammars loaded lazily | Base bundle ships no grammar; first render of an unseen language awaits a dynamic import |
| Thumbnails | to be confirmed against Bun in Phase 0 | Native image libraries are Bun's most common incompatibility — a Phase 0 spike, not a Phase 1 surprise |

Full rationale and rejected alternatives: `DECISIONS.md` D-20.

**Not in the stack, deliberately:** an ORM (D-20) · Tauri before Phase 3 (D-14) · any client-side
database (D-19) · `citext`, dropped in favour of an explicit `COLLATE "C"` (D-40) · an i18n
framework (D-41).

**Redis is deployment-dependent, not absent.** A self-hosted instance never needs it and never
will. The cloud runs several nodes and swaps in the shared adapters behind the three interfaces in
§6. One codebase, two deployments (D-7, D-25).

---

## 3. Topology

```
┌──────────────────────────────────────────────────────────┐
│  Web client — React 19 + Vite                            │
│  TanStack Query: HTTP/server state                       │
│  Zustand:        socket, optimistic buffer, presence     │
└────────────┬──────────────────────────┬──────────────────┘
             │ HTTP/REST                │ WebSocket
             │ auth, hydration,         │ messages, threads,
             │ history, search, upload  │ typing, presence, ACK
             ▼                          ▼
┌──────────────────────────────────────────────────────────┐
│  apps/api — Bun + ElysiaJS, single process               │
│                                                          │
│  ingress/http ──┐                                        │
│                 ├──▶ modules/*  (all business rules)     │
│  ingress/ws  ───┘         │                              │
│                           ▼                              │
│                     EventBus (in-process, D-7)           │
│                           │                              │
│                     realtime/hub ──▶ sockets             │
└────────────┬─────────────────────────────┬───────────────┘
             ▼                             ▼
   ┌──────────────────┐        ┌──────────────────────┐
   │  PostgreSQL      │        │  Object storage      │
   │  everything      │        │  attachments (D-16)  │
   │  durable         │        │                      │
   └──────────────────┘        └──────────────────────┘
```

Ephemeral state — presence, typing, socket registry, rate-limit counters — lives in process
memory and is allowed to be wrong after a restart. (D-7)

---

## 4. Monorepo Layout

```
purlay/
├── apps/
│   ├── api/
│   │   └── src/
│   │       ├── ingress/
│   │       │   ├── http/        route definitions only — validate, delegate, serialize
│   │       │   └── ws/          frame router, connection lifecycle, backpressure
│   │       ├── modules/         business rules; no HTTP or WS types cross this line
│   │       │   ├── auth/        GitHub OAuth, sessions
│   │       │   ├── workspaces/  tenancy, membership, roles, Deep Work
│   │       │   ├── channels/    channels, DMs, membership, read state
│   │       │   ├── messages/    messages, threads, resolution, mentions
│   │       │   ├── attachments/ upload, thumbnails, quota
│   │       │   ├── notifications/
│   │       │   ├── search/
│   │       │   └── integrations/github/  unfurl, link_previews cache
│   │       ├── realtime/        EventBus + socket hub
│   │       ├── platform/        db, storage, config, logging, errors, uuid
│   │       └── index.ts
│   │
│   └── web/
│       └── src/
│           ├── features/        vertical slices: chat, threads, palette, notifications, auth
│           ├── components/      shared primitives: CodeBlock, Markdown, Avatar
│           ├── realtime/        socket client, reconnect, replay, Zustand stores
│           ├── api/             TanStack Query hooks, typed fetch client
│           └── App.tsx
│
├── packages/
│   ├── types/                   models.ts · events.ts · api.ts — the contract
│   ├── db/                      schema.ts (Kysely) · migrations/ · client.ts
│   └── config/                  eslint · prettier · tailwind · tsconfig bases
│
├── docs/                        PRD · DECISIONS · ARCHITECTURE · SCHEMA · OVERVIEW · UX · API
└── CONTRIBUTING.md
```

**Dependency rule, enforced by lint:** `ingress → modules → platform`. A module never imports
from `ingress`. `apps/web` never imports from `apps/api` — only from `packages/*`.

*(`apps/desktop` arrives in Phase 3. It is absent from Phase 0–2 on purpose — D-14.)*

---

## 5. Transport

### 5.1. Which channel carries what

**HTTP** — anything that is a request/response, or that needs a status code, or that a browser
must be able to retry safely: OAuth, session lifecycle, initial hydration, history pages,
search, uploads, settings.

**WebSocket** — anything continuous: message send/receive, thread events, typing, presence,
read receipts, ACKs.

A message can be sent over HTTP as a fallback when the socket is down. The socket is an
optimization, never the only path — which is what makes "automatic fallback" real instead of a
word in a document.

### 5.2. Frames

Discriminated unions, defined once in `@purlay/types/events.ts`.

```typescript
export type ClientOp =
  | 'MESSAGE_SEND' | 'MESSAGE_EDIT'  | 'MESSAGE_DELETE'
  | 'THREAD_REPLY' | 'THREAD_RESOLVE'
  | 'REACTION_ADD' | 'REACTION_REMOVE'
  | 'TYPING_START' | 'CHANNEL_READ'
  | 'SUBSCRIBE'    | 'UNSUBSCRIBE'
  | 'PING';

export interface ClientFrame<Op extends ClientOp, P> {
  /** UUIDv7, generated client-side. For MESSAGE_SEND this IS the message id. (D-8) */
  id: string;
  op: Op;
  payload: P;
}

export type ServerEvent =
  | 'ACK'  | 'ERROR'
  | 'MESSAGE_CREATED' | 'MESSAGE_UPDATED' | 'MESSAGE_DELETED'
  | 'THREAD_REPLIED'  | 'THREAD_RESOLVED'
  | 'REACTION_CHANGED'
  | 'TYPING' | 'PRESENCE' | 'READ_STATE'
  | 'PONG';

export interface ServerFrame<E extends ServerEvent, D> {
  /** Echoes ClientFrame.id when this frame answers a specific client frame. */
  refId?: string;
  event: E;
  data: D;
  /** Server clock, for drift correction only. Never used for ordering. (D-8) */
  ts: number;
}
```

### 5.3. Send and reconcile

Five steps, not eight. The earlier draft needed a temporary-id → permanent-id mapping table on
the client; with a client-generated UUIDv7 there is only ever one id, so the message never
moves in the list when the ACK lands. (D-8)

```
1. Client generates a UUIDv7. It is the message id, and the frame's correlation id.
2. Append to the Zustand buffer with status 'sending'. UI paints this frame. (< 16ms)
3. Send MESSAGE_SEND.
4. Server: authenticate → authorize channel membership → validate the body (TypeBox)
   → **validate the id itself** — v7 shape, plausible timestamp (D-33)
   → **one transaction**: INSERT · thread counters · channels.last_message_at ·
     mentions · notifications · unread counters (D-35)
   → **commit** → publish to EventBus → ACK { id }.
5. Client flips status to 'sent'. No reordering, no id rewrite, no re-render of siblings.
```

**The order in step 4 is load-bearing.** Publishing before the commit lets a subscriber receive
a message that then rolls back — and because the id is durable and client-generated, the
receiving client has no way to learn it should forget it. Publish and ACK both follow the commit.
(D-35)

**Failure paths, all of which must be visible to the user:**

- **No ACK within 3 s** → status `failed`, with a retry action. Never silently dropped.
- **Retry** → resends the *same* id. The insert is `ON CONFLICT (id) DO NOTHING`, so a
  duplicate is naturally idempotent — no dedup table required. The existing row is then read back
  and its `sender_id` and `channel_id` compared with the requester: a match returns the same ACK,
  a mismatch returns `MESSAGE_ID_CONFLICT` with no ACK and no field of that row. Returning an ACK
  unconditionally would make a send an existence oracle. (D-33)
- **Socket drops** → the buffer is preserved; on reconnect, pending sends are replayed and
  missed messages are fetched by keyset cursor (§5.4).
- **Server rejects** → `ERROR` with `refId`; the optimistic row is marked failed and carries
  the reason. It is never removed without telling the user.

### 5.4. Reconnect and replay

Exponential backoff with jitter: 1s, 2s, 4s, 8s, capped at 30s. On reconnect the client sends
`SUBSCRIBE` with the highest message id it holds per channel; the server returns everything
newer by keyset scan. Because ids are time-ordered, "what did I miss" is a single indexed range
query per channel — not a timestamp comparison with clock-skew problems.

### 5.5. Backpressure and limits

- Max frame size 64 KB. Attachments never traverse the socket — they go over HTTP and the
  message carries their ids.
- Per-connection sliding window, behind the `RateLimiter` seam (§6.2). In-process is the only
  implementation in Phase 0–2; the seam exists because an in-process limiter on N nodes grants
  N times the quota (D-25). **The limit itself is not yet decided (O-4)** —
  10 frames/second with a burst of 20 is the working starting point, to be confirmed against
  real typing and paste behaviour during dogfooding. It is written here as a provisional value,
  not as a settled requirement.
- If a client's outbound buffer exceeds its high-water mark, the connection is closed with a
  resync code rather than allowed to grow without bound.

---

## 6. The Event Bus

Every fan-out goes through one interface, so Phase 3's move to Redis is an adapter swap rather
than a refactor. (D-7)

```typescript
export interface EventBus {
  publish<E extends ServerEvent, D>(topic: Topic, frame: ServerFrame<E, D>): Promise<void>;
  subscribe(topic: Topic, socketId: string): void;
  unsubscribe(topic: Topic, socketId: string): void;
}

/** `workspace:{id}` · `channel:{id}` · `user:{id}` */
export type Topic = string;
```

- **Phase 0–2:** `InProcessEventBus` — a `Map<Topic, Set<socketId>>`. No network, no
  serialization, no broker to operate.
- **Phase 3:** `RedisEventBus` — the same interface over Redis pub/sub, plus a
  `subscriberCount` check so a node does not publish to topics nobody local is watching.

Services publish; they never touch a socket. The socket hub subscribes; it never touches the
database. That separation is what makes the Phase 3 swap a one-file change.

### 6.1. `PresenceRegistry`

Presence and typing are in-memory and allowed to be lost (D-7). They are **not** allowed to be
confidently wrong, which is what an unseamed implementation would produce on a second node: each
node would see half the workspace and report the other half offline.

```typescript
export interface PresenceRegistry {
  markOnline(workspaceId: string, userId: string, socketId: string): void;
  markOffline(socketId: string): void;
  onlineIn(workspaceId: string): Promise<ReadonlySet<string>>;
  startTyping(channelId: string, userId: string, ttlMs: number): void;
  typingIn(channelId: string): Promise<ReadonlySet<string>>;
}
```

Phase 0–2: `InMemoryPresenceRegistry`. Phase 3: the same interface over the shared bus.

### 6.2. `RateLimiter`

```typescript
export interface RateLimiter {
  /** Returns false when the caller is over budget. Never throws, never blocks. */
  consume(key: string, cost?: number): Promise<boolean>;
}
```

Phase 0–2: an in-process sliding window that resets on restart, which is acknowledged in O-4.

### 6.3. Why these three and nothing else

These are the only pieces of node-local state whose *correctness* changes under D-25's ceiling.
Everything else in the process — connection registry, caches, the config object — is either
derived from the database or genuinely per-node. Declaring an interface costs a file; retrofitting
one costs a refactor, which is the whole argument. Adding a fourth seam "just in case" is the
speculative generality this project rejects (`CONTRIBUTING.md` §1.11).

---

## 7. Authentication & Tenant Isolation

### 7.1. Sign-in

> Endpoint paths below appear as part of describing the handshake. The endpoint contract
> itself — every route, its phase and its required role — lives in `API.md`, which is the
> single source of truth. Adding a route here instead of there is a bug.

1. `GET /auth/github` → redirect with a `state` value stored in a short-lived signed cookie.
   Scopes: **`read:user user:email`**, nothing more. Repository access belongs to the
   workspace-level integration token (D-23), never to a member's sign-in. (D-38)
2. `GET /auth/github/callback` → verify `state`, exchange the code, fetch the profile **and
   `/user/emails`**.
3. Resolve identity (D-38): take the primary **verified** email, or refuse with `EMAIL_REQUIRED`.
   Upsert `users` by `github_id`. A different `github_id` carrying an already-registered email is
   refused with `ACCOUNT_EMAIL_CONFLICT` — **never linked silently** (D-5). `username` is
   refreshed from GitHub's `login` and is display-only; a collision caused by a rename is stored
   with a numeric suffix and logged.
4. Generate a 32-byte random token. Store **only its SHA-256** in `sessions`. (D-11)
5. Set `purlay_session`: `HttpOnly`, `Secure`, `SameSite=Lax`, 30-day expiry.

`state` verification is not optional — without it the callback is a CSRF endpoint that logs
victims into an attacker's account.

**Open join.** When `WORKSPACE_OPEN_JOIN_SLUG` is set, a user who is not yet a member of that
workspace is joined as `member` here. Unset by default; Phase 0 cannot reach its exit criterion
without it, because invitations are Phase 1. (D-37)

### 7.2. WebSocket upgrade

The upgrade request carries the same cookie. The session is looked up **before** the socket is
bound; an invalid or expired session is rejected at handshake, never after. There is no
token-in-query-string path — query strings land in access logs.

### 7.3. The isolation mechanism

The rule "every query filters on `workspace_id`" fails eventually if it depends on remembering.
So it is made structural:

```typescript
/** Cannot be constructed by callers. Produced only by the membership guard,
 *  and only after verifying this user actually belongs to this workspace. */
export interface WorkspaceContext {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: UserRole;
  readonly __brand: unique symbol;
}
```

Workspace-scoped repositories accept a `WorkspaceContext` as their first argument and apply the
filter internally. A caller who has not passed through the guard has no way to obtain one, so
an unscoped query does not compile.

**Not-found over forbidden.** Requesting another workspace's resource returns **404**, never
403. A 403 confirms the resource exists, which is itself a leak.

Every workspace-scoped endpoint carries a cross-tenant test asserting 404. (D-21)

### 7.4. Authorization

| Action | owner | admin | member |
|---|:--:|:--:|:--:|
| Delete workspace, transfer ownership | ✅ | — | — |
| Manage members and roles | ✅ | ✅ | — |
| Configure GitHub integration | ✅ | ✅ | — |
| Create / archive channels | ✅ | ✅ | ✅ |
| Delete any message | ✅ | ✅ | — |
| Edit / delete own message | ✅ | ✅ | ✅ |
| Resolve a thread | ✅ | ✅ | ✅ |

The last owner cannot be demoted or removed (invariant I-2).

### 7.5. Channel visibility — the second axis

§7.3 makes the *tenant* filter structural. Authorization here has two axes, and private channels
and DMs are the other one. Leaving it to call sites is the discipline model D-21 rejects, one
axis over. (D-34)

```typescript
/** Cannot be constructed by callers. Produced only by the channel guard,
 *  and only after verifying this user can see this channel. */
export interface ChannelContext {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly channelType: ChannelType;
  readonly userId: string;
  readonly __brand: unique symbol;
}
```

Channel-scoped repositories take a `ChannelContext` and apply the filter internally, so an
unscoped query does not compile. **Workspace-wide reads — search and the open-questions view —
take the set of channel ids this user can see from the guard and narrow with
`channel_id = ANY($1)`**, which is also what confines the trigram scan to a few channels instead
of the whole tenant.

Like §7.3, the answer across a boundary is **404**. Every channel-scoped endpoint carries an
intra-workspace visibility test asserting it.

---

## 8. Content Pipeline

### 8.1. Parsing, at write time

Parsing happens **once, on the server, when the message is written**. The parser produces
`metadata` (`SCHEMA.md` §6.4) and the `mentions` rows.

It exists for three reasons: mentions are resolved once and stored as rows, `metadata` is derived
once rather than per feed render, and sanitisation happens in exactly one place. It does **not**
exist to save client render cost — the rendered output is not stored, and an earlier version of
this document claimed otherwise. The client renders the markdown and memoises the result per
`(message.id, edited_at)`. Markdown remains the only stored representation. (D-36)

1. Parse GFM via `unified`/`remark`.
2. Extract `@username` mentions → resolve against workspace members → `mentions` rows.
   **`@here` and `@channel` are rejected here**, structurally, not by convention. (D-12)
3. Record fenced code block languages → `metadata.codeLanguages`.
4. Detect GitHub PR/Issue URLs → `metadata.githubLinks`.
5. Sanitize: no raw HTML, no `javascript:` URLs, external images proxied.

### 8.2. Rendering

- Code blocks over 12 lines clamp to 280px with a gradient mask, and carry a language badge,
  line count, expand/collapse and copy-raw.
- Syntax highlighting runs synchronously by default. It moves to a Web Worker **only where a
  measurement shows a dropped frame** — for a clamped 12-line block, the `postMessage`
  round-trip costs more than the highlight. (Corrects an earlier blanket rule.)
- The diff viewer is Phase 2.

### 8.3. GitHub unfurling

```
Client detects a GitHub URL
      └─▶ POST /api/integrations/github/unfurl { url }
              ├─ hash the normalized URL
              ├─ SELECT FROM link_previews WHERE url_hash = $1 AND expires_at > NOW()
              │     └─ hit  → return
              └─ miss → GitHub API with the WORKSPACE token (D-23)
                        ├─ 200 → upsert, TTL 5 min → return
                        └─ 404 → cache the negative, TTL 1 h → return null
```

Negative caching matters: without it, one broken link pasted in a busy channel re-hits the API
on every render for every viewer.

```typescript
export interface GitHubCardMetadata {
  type: 'pr' | 'issue';
  repo: string;
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  author: { login: string; avatarUrl: string };
  ciStatus?: 'success' | 'failure' | 'pending';
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';
}
```

---

## 9. Attachments

1. `POST /api/uploads` with the file → validate MIME and size against the `attachment_size_limit`
   constraint in `SCHEMA.md` §7.2, which is the single source of truth → check the workspace
   quota → store under an opaque key → return an `attachment.id`. `message_id` is still null.
2. The message is sent carrying those ids; the service links them and adds to
   `storage_used_bytes` in the same transaction.
3. Orphans older than 24 h are swept.

Downloads are always brokered by the API so membership is actually checked; storage keys are
never public URLs. Images are downscaled and a thumbnail is stored alongside.

---

## 10. Errors, Observability, Testing

**Errors.** One `AppError` type whose `code` is a **discriminated union in `@purlay/types`**, not
a free string — so a client can handle it exhaustively and adding a code breaks the switch that
forgot it (D-47). Never leak internals to the client; never swallow an error to make a code path
look clean. A caught error is either handled or re-thrown — logging and continuing is prohibited.

**Logging.** Structured JSON (`pino`) with a request id that flows through HTTP, WS and service
calls **from the first handler** — threading it through afterwards touches every signature (D-47).
Never logged: session tokens, `access_token_encrypted`, message content, email addresses.

**Executors are arguments.** Every service and repository takes its `Kysely<Database>` or
`Transaction<Database>` as a parameter rather than reaching for a module-level handle. This is what
makes one-transaction-per-test possible, and it is enforced by the same lint boundary as the
layering rule. (D-46)

**Health.** `/health` (liveness) and `/health/ready` (database reachable, migrations applied).

**Testing (D-21).**

| Layer | What it proves |
|---|---|
| Unit | Service rules and the invariants in `SCHEMA.md` §11 |
| Integration | Real PostgreSQL, real migrations, one per endpoint |
| **Tenant isolation** | **Every workspace-scoped endpoint returns 404 across tenants — mandatory, no exceptions** |
| **Channel visibility** | **A workspace member who is not in the channel returns 404 — every channel-scoped endpoint, plus search and open questions (D-34)** |
| Message id | Non-v7, skewed and colliding ids are rejected; a same-sender retry is idempotent (D-33) |
| Permission | Every role-gated action, per role |
| Realtime | Two sockets, ordering, ACK, reconnect replay, duplicate-send idempotency |
| Generated types | Regenerating `packages/db/src/schema.ts` from the applied migrations produces no diff (D-45) |
| Architecture fitness | No module imports from `ingress`; every endpoint in `API.md` has a cross-tenant test; `OFFSET` never appears in a `messages` query; every cross-document reference resolves (D-47) |
| Audit | Every administrative action writes exactly one `audit_log` row; no service issues `UPDATE` or `DELETE` against it (I-9) |
| Retention | The purge deletes nothing when `retention_days IS NULL` and never a message inside the window (I-10); erasure never removes a message (I-11) |

`typecheck` + `lint` + `test` gate every merge. No `any`. Every bug fix ships with a regression
test.

---

## 11. Deployment

**Two deployments, one codebase.**

*Self-hosted* is a single API process, one PostgreSQL, one bucket, vertical scaling only — and
stays that way permanently. A thirty-person team is never asked to install a broker.

*Cloud* runs several API nodes behind a sticky-session load balancer with the shared `EventBus`,
`PresenceRegistry` and `RateLimiter` adapters, plus point-in-time recovery, external uptime
monitoring and error tracking (D-44). Tenancy stays row-level in one database (D-42).

The build target, the multi-node ceiling and the numeric triggers between them are owned by
`DECISIONS.md` D-25 — this section deliberately does not restate the numbers.

`docker compose` brings up `api`, `web`, `postgres`, `minio` and a **scheduler** container that
runs the CLI jobs on a cron (D-30). The scheduler ships wired by default: the known failure mode
of external scheduling is the cron nobody installed, and every run records its outcome in
`job_runs` (`SCHEMA.md` §9.2) so `purlay jobs:status` can report *last successful run* per job. Migrations
run on start and are idempotent.

Phase 3 introduces multiple API nodes behind a sticky-session load balancer and swaps in
`RedisEventBus`, `SharedPresenceRegistry` and `SharedRateLimiter`. Nothing above changes: the
three seams in §6 were placed for exactly this, and background work already runs outside the API
process (D-30), so no job needs a distributed lock.
