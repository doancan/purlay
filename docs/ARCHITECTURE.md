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

| Layer | Choice | In the repo | Cost we accepted |
|---|---|---|---|
| Monorepo | Bun workspaces | built in | No task graph and no remote cache: a pipeline that repeats work is the trigger to add one (D-55) |
| Dead code | `knip`, pinned | `knip` | Fails the build on an export nothing imports; its few exemptions are named in `knip.jsonc` with a reason and an issue. `docs/spikes/knip.md` (D-48) |
| Logging | `pino` | `pino` | Behind a facade in `platform/logging.ts`; `docs/spikes/pino.md` (D-44, D-71) |
| i18n | typed message catalogues + `Intl` | none, on purpose | No library: two catalogues to keep in step by hand, in exchange for keeping the 250 KB budget (D-41) |
| Runtime | Bun | built in | Young ecosystem; fewer battle-tested libraries; fewer managed hosts |
| HTTP + WS | ElysiaJS | `elysia` | Smaller community than Express/Fastify; docs move fast. **The highest-risk choice now that the cloud carries an uptime commitment** — Hono is the written fallback with a four-week trigger (D-20) |
| Database | PostgreSQL, latest stable major | `postgres` | Ships a native `uuidv7()` we deliberately do not use — D-8 needs the id client-side |
| Query builder | Kysely | `kysely`, `pg` | No migration tooling and no relation loading; we write SQL and joins by hand |
| Validation | TypeBox | `@sinclair/typebox` | Shared with Elysia's schema layer, so one definition validates and types |
| Web | React + Vite, single-page with a **prerendered shell** | `react`, `react-dom`, `vite` | Cold load is met by shipping less, not by rendering elsewhere; server rendering would fight the optimistic model (D-50) |
| UI primitives | Radix, for dialog · menu · tooltip · popover only — the command palette is **undecided**, because Radix publishes no combobox | `@radix-ui/react-dialog`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-tooltip`, `@radix-ui/react-visually-hidden`, and D-98 for the palette | One package per primitive so only what is used ships; everything else is written here (D-52) |
| Component tests | `bun test` + `happy-dom` + Testing Library | `@happy-dom/global-registrator`, `@testing-library/react`, `axe-core` | `happy-dom` arrives as the registrator's own dependency, not a separate pin (nothing imports it; knip). Two tools with two jobs — logic and accessibility here, browser behaviour in Playwright |
| Browser tests | Playwright + `@axe-core/playwright` | `@playwright/test`, `@axe-core/playwright` | Keyboard paths, visual snapshots in every theme and at two widths, and the cold-load measurement, against the production build and a seeded real API (`scripts/demo.ts`). Snapshot maintenance is a real cost, accepted (D-52); a snapshot depends on the machine's fonts |
| Styling | Tailwind CSS, its default theme **not imported** | `tailwindcss`, `@tailwindcss/vite` | Verbose markup. Only the tokens exist as classes; a bare number (`z-50`) still builds, so lint and a vocabulary test catch what the theme cannot (D-97, `docs/spikes/design-tokens.md`) |
| Design tokens | one JSON file → generated CSS custom properties, Tailwind binding and names | none, on purpose | Ours (`packages/tokens`): about 1,300 lines with its comments and 650 of tests, and no build-tool dependency; Style Dictionary was not evaluated (D-97). Contrast is a build gate, not a claim |
| Icons | `lucide-react`, behind one component | `lucide-react` | +2.4 KB gzipped for twelve icons, 1.2 KB more than the lighter candidate; reached only through `components/icon.tsx` (D-97, `docs/spikes/design-tokens.md`) |
| Server state | TanStack Query | `@tanstack/react-query` | (D-18) |
| Realtime state | Zustand | `zustand` | (D-18) |
| Object storage | S3-compatible; Garage locally | `garage` | An extra service locally, set up by a script because its image has no shell; no console. Any S3-compatible store works in production, and a filesystem driver exists for simple self-hosts (D-20; `docs/spikes/object-storage.md`) |
| Markdown | one engine on both sides — micromark through `mdast-util-from-markdown`, four GFM extensions — narrowed and bounded in `packages/markdown` | `mdast-util-from-markdown`, `micromark-extension-gfm-*`, `mdast-util-gfm-*` | Its browser cost, and superlinear past bounds that are enforced before it runs, so a body past them is shown as typed — both measured in `docs/spikes/markdown.md` (D-101) |
| Highlighting | Shiki, grammars loaded lazily | `shiki` | Base bundle ships no grammar; first render of an unseen language awaits a dynamic import |
| Thumbnails | `Bun.Image`, built into the runtime | built in | A young API, and its decoder differs by platform — `docs/spikes/image-pipeline.md`; thumbnails must use `fit: 'inside'`, because the two-dimension form stretches (D-75) |

Full rationale and rejected alternatives: `DECISIONS.md` D-20.

**The third column is checked.** `installed` is not a word here — a cell names the packages or
compose services that make the row real, and a test resolves every one of them. `not yet` names
them too, and the test requires them to be **absent**, so a row cannot quietly stay behind after
its thing is installed. `undecided` means no package has been chosen and must cite the issue or
open question that will choose it. Turborepo sat in this table for months because there was no
such column. (D-59)

**No version numbers here, on purpose.** A version is a fact, and its home is the manifest that
installs it — `package.json`, `bun.lock`, `docker-compose.yml`. A table that also carries the
number is a second copy, and the second copy is the one that goes stale without anybody noticing:
this document named a superseded database major for months, and named a web framework version
while nothing had installed the framework at all. The check that keeps every other document free
of versions now applies to this one too — and it caught this paragraph naming them. (D-56)

**Not in the stack, deliberately:** an ORM (D-20) · Tauri before Phase 3 (D-14) · any client-side
database (D-19) · `citext`, dropped in favour of an explicit `COLLATE "C"` (D-40) · an i18n
framework (D-41) · **a component library with opinions** (D-52) — headless primitives *are* in the
stack, because focus and ARIA fail silently when hand-written; an imposed visual identity is not,
because the interface is the product's face · server-side rendering (D-50).

**Redis is deployment-dependent, not absent.** A self-hosted instance never needs it and never
will. The cloud runs several nodes and swaps in the shared adapters behind the three interfaces in
§6. One codebase, two deployments (D-7, D-25).

---

## 3. Topology

```
┌──────────────────────────────────────────────────────────┐
│  Web client — React + Vite                               │
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
│  realtime/   ───┘         │                              │
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
│   │       │   ├── http/        route definitions only — validate, delegate, serialize,
│   │       │                  plus the one error handler: AppError → its status, else INTERNAL
│   │       │   └── ws/          the socket's lifecycle — admit, open, frame, close — wired to
│   │       │                  `/ws` by the composition root in `http/app.ts`
│   │       ├── realtime/        the socket door: frame router, hub (connection lifecycle,
│   │       │                  backpressure), the in-process EventBus, the rate limiter
│   │       ├── modules/         business rules; no HTTP or WS types cross this line
│   │       │   ├── auth/        GitHub OAuth, sessions (opaque token, SHA-256 at rest)
│   │       │   ├── workspaces/  tenancy, membership, roles, Deep Work
│   │       │   │              ownership is a membership row, never a column (D-22)
│   │       │   ├── channels/    channels, DMs, membership, read state
│   │       │   ├── messages/    messages, threads, resolution, mentions
│   │       │   │              keyset on the id alone; OFFSET is a check, not advice
│   │       │   ├── attachments/ upload, thumbnails, quota
│   │       │   ├── notifications/
│   │       │   ├── search/
│   │       │   └── integrations/github/  unfurl, link_previews cache
│   │       ├── platform/        the bottom layer: config, clock, errors, tenancy, channel
│   │       │                  visibility, the EventBus seam, the transaction boundary
│   │       ├── testing/         fixtures every layer's tests may use; never imported by code
│   │       └── index.ts
│   │
│   └── web/
│       └── src/
│           ├── app/             providers (one tree, every port optional), the frame, the outlet
│           ├── features/        vertical slices: chat, threads, palette, notifications, auth
│           ├── ui/              primitives on Radix where focus and ARIA fail silently; token classes only
│           ├── components/      shared pieces: Icon (the one door to the icon set), CodeBlock, Markdown
│           ├── theme/           light, dark and system — per device, set before first paint (D-98)
│           ├── i18n/            typed catalogues over Intl, one chunk per language (D-41)
│           ├── router/          a typed route table, Link, useRoute — no dependency (D-98)
│           ├── realtime/        socket client, reconnect, replay, Zustand stores
│           ├── api/             TanStack Query hooks, typed fetch client
│           ├── gallery/         every primitive in both themes at once; development only
│           ├── testing/         the component-test DOM, fakes, axe — registered here, never globally
│           └── main.tsx         the entry: mounts the application
│
├── packages/
│   ├── types/                   models.ts · events.ts · api.ts — the contract
│   ├── db/                      schema.ts (Kysely) · migrations/ · client.ts
│   ├── markdown/                the one reading of a body, for the server and the browser (D-101)
│   ├── tokens/                  tokens.json and what is generated from it (D-97)
│   └── config/                  eslint · prettier · tailwind · tsconfig bases
│
├── docs/                        PRD · DECISIONS · ARCHITECTURE · SCHEMA · OVERVIEW · UX · API
└── CONTRIBUTING.md
```

**Dependency rule, enforced by lint:** the two doors — `ingress/http` and `realtime` — call
`modules`, and `modules` call `platform`. A module never imports from either door, and `platform`
imports from nothing above it. `realtime` never imports `ingress` (ingress composes it), and
production code never imports `testing/` — both are lint rules. A route handler or frame handler validates, calls one service and
serializes: sign-in, the `/me` read and the fan-out that ends a session's sockets are in `modules` and
`platform/events.ts` (D-47). `apps/web` never imports from `apps/api` — only from `packages/*`.
`packages/markdown` runs in both, so it imports no database, no app and no Node or Bun module
(D-101).

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

Discriminated unions, defined once in `packages/types/src/events.ts` — the frames, the close codes
and the limits a client must know. Not restated here: the copy that was here listed twelve client
operations against the contract's four and had lost a server event.

What the shape is for, which the types do not say:

- **A client frame is `{ id, op, payload }`.** `id` is a client-generated UUIDv7; for `MESSAGE_SEND`
  it *is* the message id, so the optimistic row and the stored row never differ (D-8).
- **A server frame is `{ event, data, ts, refId? }`.** `refId` echoes the client frame it answers,
  which is how an optimistic send is reconciled. `ts` is the server clock, for drift correction and
  never for ordering — ordering is the id (D-8).
- **A frame exists when the feature that sends it is built.** The client sends messages (a reply
  carries `parentId`), subscribes, unsubscribes and pings. Resolution, reactions and read state are
  HTTP and are heard here as `THREAD_UPDATED`, `REACTIONS_UPDATED` and, on the person's own `user:`
  topic, `CHANNEL_STATE` and `CHANNEL_ADDED` (D-98, D-99). An edit and a delete are heard as
  `MESSAGE_REVISED` on the channel's topic: the words, the times and the mentions, at the message's
  version, never its reactions or thread (D-103). Typing is a `TYPING` frame
  each way (D-114): the client names a channel it can see and is answered with nothing; the room
  hears who, and for how long, at most once per half window per person. Nothing says "stopped" — a
  listener forgets a person when that runs out or their message arrives. Each frame joined the union
  with its feature, so an exhaustive switch breaks where a case is unhandled rather than carrying
  stubs for features that do not exist.

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
  unconditionally would make a send an existence oracle. A retry is late by nature, so the
  plausibility window does not refuse it: an id outside the window that matches the sender's own
  row in the channel returns that row, and any other id outside the window is refused identically
  whether or not it exists. (D-33)
- **Socket drops** → the buffer is preserved; on reconnect, pending sends are replayed and
  missed messages are fetched by keyset cursor (§5.4). A send the server never had — the HTTP door
  got no answer, or only a proxy's 502/503/504 while the API was down — is still pending, and is
  replayed with them even though it is shown as failed meanwhile. A timeout or a refusal is not: its
  Retry is the person's.
- **Server rejects** → `ERROR` with `refId`; the optimistic row is marked failed and carries
  the reason. It is never removed without telling the user.

### 5.4. Reconnect and replay

Exponential backoff with jitter: 1s, 2s, 4s, 8s, capped at 30s, each drawn from the upper half of
its step and started over only by a connection that held for ten seconds (D-76). On reconnect the client sends
`SUBSCRIBE` with the highest message id it holds per channel; the server returns what it may have
missed by keyset scan. Because ids are time-ordered, "what did I miss" is a single indexed range
query per channel — not a timestamp comparison with clock-skew problems.

**The scan starts below that id, not at it.** The server accepts an id up to a minute old (D-33), so
a message written after the client stopped listening can sort beneath the newest one it holds — a
send that waited out its own dropped connection does exactly that. The replay therefore begins
`REPLAY_OVERLAP_MS` earlier, a window derived from `MESSAGE_ID_SKEW`, and the client discards what
it already holds by id. **The acknowledgement says where each channel's replay stopped**: a
`nextCursor` of `null` means it reached the present; anything else means it was one page, and the
client continues over HTTP with `?after=` from there. (D-65)

**The cursor advances on any live frame — which is safe only once that continuation is complete.**
A replay that was one page ends at its `nextCursor`; everything between there and the present is
still missing. If a live `MESSAGE_CREATED` then moved the cursor past the gap and the socket dropped
again, the next `SUBSCRIBE` would resume from beyond it and the gap would be skipped for good, with
nothing saying so. So the connection withholds a live frame's advance, for a channel, from the
moment its `ACK` carries a `nextCursor` until the store reports the HTTP continuation has reached
the present (`pendingContinuations`, `continuationDone`). The frame itself is still delivered; ids
at or below `nextCursor` (the replayed page) still advance it, as do pages the store `observe`s
while it continues, which are contiguous by construction. Each new connection discards what the
last one owed, because its own replay answers afresh. The store's side of the contract: continue
every pending channel from the `nextCursor`, `observe` each page, call `continuationDone` with the
cursor it started from, and restart the continuation from the new `nextCursor` if the connection
reconnects before it finishes. (D-82)

**The connection checks that it is alive, and that it may retry.** While open it sends a `PING`
after 25 s of silence and treats 15 s without *any* frame — a `PONG`, a message, an event it does
not know — as a dead socket: it closes and reconnects without waiting for the operating system's
own timeout, which for a half-open socket is minutes. The first `PONG` also measures the server's
clock (D-33). A handshake the server refuses is indistinguishable in the browser from an outage, so
after three consecutive attempts that never reached `open` the client asks the API whether the
session still exists and stops on a 401; a network error or a 5xx keeps it retrying. An event the
client does not know is ignored (a newer server is not a fault); a frame that is not JSON, or has
no string `event`, or is a known event with the wrong data, ends the connection. After `ended`,
`start()` connects again. (D-82)

**A large subscription is sent one chunk at a time.** A frame names at most `SUBSCRIBE_MAX_CHANNELS`
channels, so 3,500 watched channels are 35 frames. Sent together they exceed the connection's frame
budget (§5.5: the surplus is answered `RATE_LIMITED`, which nothing retried) and then its queue bound
(the close `TOO_BUSY`, 1013, on every attempt, forever). The client sends the next chunk when the last
is acknowledged, sends a chunk again after a growing wait when it is answered `RATE_LIMITED` or
`DATABASE_UNAVAILABLE`, and begins the wait after a `TOO_BUSY` close part-way up the backoff ladder
rather than at the bottom. It reads none of the server's limits; waiting for the answer needs none.
(D-82)

**Every reconnect replays what was already held, on purpose.** The scan starts `REPLAY_OVERLAP_MS`
(65 s) below the cursor (D-65), so each subscription answers with up to 1,000 frames of messages the
client already has and discards by id. That is the price of never missing a message that was written
late: a storm of 300 sockets reconnecting at once pulled 90,000 frames. It is paid per reconnect, not
per message, bounded by the replay's own caps (§5.5), and spread by the backoff's jitter (D-76). A
narrower window would be cheaper and would lose the late send D-65 exists to catch.

**A subscription is bounded, and costs the same whatever it names.** One frame names at most
`SUBSCRIBE_MAX_CHANNELS`, each once. Every channel is authorised in one query before any is
subscribed — one the caller cannot see refuses the frame, and nothing is left half-subscribed — and
every channel's replay is read in one more, sharing a fixed total so a hundred channels a page behind
is not ten thousand frames from one. (D-69)

**The subscription is made before the replay is read.** Live frames for the connection are held
until the acknowledgement and the replay are written, then sent, minus any message the replay already
carried by id. Read first, a message committed between the read and the subscription would be in
neither. (D-83) A channel the subscription is then refused, or that is revoked while frames are held,
loses **every** frame held for it — each kind of frame says which channel it is about, or that it is
about none, so one added later cannot slip past (#412).

### 5.5. Backpressure and limits

- Max frame size 64 KB, enforced by the server for every connection: a frame over it ends that
  connection before any handler runs. Attachments never traverse the socket — they go over HTTP and
  the message carries their ids. (D-66)
- Per-connection token bucket, behind the `RateLimiter` seam (§6.2). Over budget, the frame is
  refused with `RATE_LIMITED` and its id; the connection stays open. In-process is the only
  implementation in Phase 0–2; the seam exists because an in-process limiter on N nodes grants
  N times the quota (D-25). **The number is not yet decided (O-4)** — 10 frames/second with a
  burst of 20 is what is enforced, as a provisional value, until dogfooding measures it.
  **The budget is also the user's:** `MESSAGE_SEND` is charged to a per-user bucket shared with HTTP's
  writes, and a user (20) and a node (2,000) may hold only so many sockets, refused at the upgrade with
  `429` / `503` (D-84, amended; provisional, O-4).
- HTTP has limits of its own behind the same seam: `/auth/*` per client address, mutations per signed-in
  user at the socket's budget, so `POST /messages` is no cheaper than a frame. A refusal is `429`
  with `Retry-After`. Provisional, as above (D-81).
- If a client's outbound buffer passes `OUTBOUND_HIGH_WATER_MARK`, or the transport drops a frame,
  the connection is closed with `CLOSE_CODES.RESYNC`; the client reconnects and replays from its
  cursor. Every frame to a socket — fan-out and replies alike — goes through that check. A replay is
  bounded in bytes as well as messages, below the mark, so a healthy reader is never closed by its
  own replay. (D-70)
- **A connection's frames are handled one at a time, in the order they arrived**, behind a queue of
  at most `FRAME_QUEUE_MAX`. A connection that fills it is closed with `CLOSE_CODES.TOO_BUSY` and
  reconnects; a drain waits for the frame being handled before the pool closes. (D-84)

---

## 6. The Event Bus

Every fan-out goes through one interface, so Phase 3's move to Redis is an adapter swap rather
than a refactor. (D-7)

The interface and the topic names are `apps/api/src/platform/events.ts`; `Topic` itself is part of
the wire contract in `@purlay/types`. Not restated here: the copy that was here had already lost a
method and a topic. The interface sits in the bottom layer because both sides of it are above —
services publish, the hub subscribes — and a service that publishes must not import the layer that
imports it.

**One send path.** `send` in `modules/messages` owns the order D-35 fixes — one transaction, publish
after the commit, acknowledge after the publish — and both doors call it, so HTTP is a fallback
with the same guarantees rather than a second implementation. Its boundary is `atomicallyOn`
(`platform/transactions.ts`): a new transaction, or the caller's when there is one.

**Every service that writes twice takes a `Transaction`**, not the pool: creating a workspace or a
channel, and sign-in's account, membership and session, either write everything or nothing, and
the type refuses the pool (D-77).

- **Phase 0–2:** `InProcessEventBus` — a `Map<Topic, Set<socketId>>`. No network, no
  serialization, no broker to operate.
- **Several nodes:** each node's bus is a view onto a `Backplane` (`realtime/bus.ts`): it holds only
  its own sockets' subscriptions, and a publish from any node reaches every node's subscribers.
  One process makes its own backplane; the tests share one between two applications, which is how
  a revocation is shown to reach the other node's sockets (D-85).
- **Phase 3:** `RedisEventBus` — the same interface over Redis pub/sub, plus a
  `subscriberCount` check so a node does not publish to topics nobody local is watching.

**Delivery is isolated per subscriber.** The message is committed before the bus fans it out, so a
send that throws for one socket is logged with that socket's id (never the frame) and the rest still
receive it; the publisher is not told. A closed socket is `forget`-ed from the bus, the limiter and the
hub, and a test asserts all three sizes return to zero.

Services publish; they never touch a socket. The socket hub subscribes; it never touches the
database. That separation is what makes the Phase 3 swap a one-file change.

### 6.1. `PresenceRegistry`

Presence and typing are in-memory and allowed to be lost (D-7). They are **not** allowed to be
confidently wrong, which is what an unseamed implementation would produce on a second node: each
node would see half the workspace and report the other half offline.

```typescript
export interface PresenceRegistry {
  /** True when the room should be told: the first announcement, or the last one half spent. */
  startTyping(channelId: string, userId: string, ttlMs: number): boolean;
  /** Their message arrived: the next keystroke is announced at once. */
  stopTyping(channelId: string, userId: string): void;
}
```

The interface grows with its features (D-114): typing now, online presence when it is built. Phase
0–2: `inMemoryPresenceRegistry` (`realtime/presence.ts`). Phase 3: the same interface over the shared
bus — on two nodes a person typing on both is announced once by each, a frame too many and never a
wrong answer.

### 6.2. `RateLimiter`

```typescript
export interface RateLimiter {
  /** Returns false when the caller is over budget. Never throws, never blocks. */
  consume(key: string, cost?: number): Promise<boolean>;
  /** Drops what is held for a key nobody will use again — a closed connection's. */
  forget(key: string): void;
}
```

Phase 0–2: an in-process token bucket that resets on restart, which is acknowledged in O-4.
`forget` exists because the key is a connection: without it every reconnect leaves a bucket behind.

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
5. Set the session cookie — named, with its attributes, in `apps/api/src/platform/cookies.ts`: `__Host-`-prefixed, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, 30-day expiry — and spend the `state` cookie, on this and every other outcome. (D-62)

`state` verification is not optional — without it the callback is a CSRF endpoint that logs
victims into an attacker's account. The cookie carrying it is **signed**, with a key derived from
`ENCRYPTION_KEY` rather than a second secret: a sibling subdomain can write a cookie for this
origin, so an equality check alone would still let an attacker supply both halves (D-62). Every way
the handshake can be wrong produces the same refusal.

**Validating one.** The token is looked up by its hash, and a session resolves only while it is
unexpired, unrevoked, and owned by a user who has not been deleted — a soft-deleted account does
not keep a live session. Every reason to refuse produces the same answer, so an unauthenticated
caller cannot learn from it whether a token was ever real or an account ever existed. `last_used_at`
is refreshed at most once an hour rather than on every request. (D-60)

**Signing in joins nothing.** A person enters a workspace by creating it or by an invitation link
(D-115); Phase 0's open join (D-37) is retired, and its variable is refused at boot.

### 7.2. WebSocket upgrade

The upgrade request carries the same cookie. The session is looked up **before** the socket is
bound; an invalid or expired session is rejected at handshake, never after. There is no
token-in-query-string path — query strings land in access logs.

**After the handshake, a connection lives exactly as long as its session.** Signing out and signing
out everywhere publish `SESSION_ENDED` on each revoked session's topic; expiry is a timer set from
`expires_at` when the socket opens. Either way the frame is delivered first and the connection is
then closed with `CLOSE_CODES.SESSION_ENDED`, so the client knows not to reconnect into a refusal.
The session is **not** re-read per frame. (D-68)

**The same is true of the account and of a membership, on every node.** Deleting a user publishes
`SESSION_ENDED` (`account-deleted`) on `user:{id}`, where each of their sockets listens, and the
connection closes. Losing a channel — removed from a workspace or a private channel, leaving, or the
channel being deleted — publishes `ACCESS_REVOKED` on `user:{id}` or `channel:{id}`: the hub
unsubscribes the socket from those channels and the connection stays open. No visibility query runs
per delivered frame. A subscription is made before its channels are authorised so a revocation
cannot slip between the two. Phase 1's endpoints must publish these after they commit; the
functions are in `platform/events.ts` and D-85 lists which endpoint calls which.

`revocation-contract.test.ts` fails the build if a production write that removes visibility has no
decision in its table. **Operators:** a session revoked, a membership deleted or a user soft-deleted by
SQL, outside the application, does not end an open socket — nothing publishes — until the session expires
or the process restarts (a drain, §11 / D-72). There is no command-line tool for it: the bus is in-process
and another process cannot reach it (D-85).

A socket subscribes to its topics **before** its session is confirmed by a second read, so a sign-out
while it opens is seen by one or heard by the other (D-85, amended). A replay read after a revocation was observed does not
write that channel's messages (D-85, amended).

### 7.3. The isolation mechanism

The rule "every query filters on `workspace_id`" fails eventually if it depends on remembering.
So it is made structural:

```typescript
/** Cannot be constructed by callers. Produced only by the membership guard,
 *  and only after verifying this user actually belongs to this workspace. */
const tenancy: unique symbol = Symbol('WorkspaceContext');

export interface WorkspaceContext {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: UserRole;
  readonly [tenancy]: true;
}
```

The brand is a property keyed by a symbol the module does not export, rather than a
`readonly __brand: unique symbol` — that form is uninhabited, so not even the guard could produce
one. (D-54)

Workspace-scoped repositories accept a `WorkspaceContext` as their first argument and apply the
filter internally. A caller who has not passed through the guard has no way to obtain one, so
an unscoped query does not compile. An assertion would be the way around it, so asserting a
`*Context` into existence is a lint error everywhere, with no exemption. (D-54)

**Not-found over forbidden.** Requesting another workspace's resource returns **404**, never
403. A 403 confirms the resource exists, which is itself a leak. The guard has one refusal and
raises it for both "no such workspace" and "not your workspace", so the two are indistinguishable
by construction rather than by two branches kept in step. A `:workspaceId` that is not a UUID
takes the same refusal: handed to PostgreSQL it raises on the cast, and the boundary would answer
500 where it promised 404.

Every workspace-scoped endpoint carries a cross-tenant test asserting 404 (D-21), and which
endpoints those are is read from `API.md` and checked by the build rather than remembered (D-63).

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

The last owner cannot be demoted or removed (invariant I-2). Making somebody an owner is transferring
ownership, and an owner's row is an owner's to change; a removed member loses the workspace's channels
and their sockets are told (D-111).

### 7.5. Channel visibility — the second axis

§7.3 makes the *tenant* filter structural. Authorization here has two axes, and private channels
and DMs are the other one. Leaving it to call sites is the discipline model D-21 rejects, one
axis over. (D-34)

```typescript
/** Cannot be constructed by callers. Produced only by the channel guard,
 *  and only after verifying this user can see this channel. */
const visibility: unique symbol = Symbol('ChannelContext');

export interface ChannelContext {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly channelType: ChannelType;
  readonly userId: string;
  readonly [visibility]: true;
}
```

Channel-scoped repositories take a `ChannelContext` and apply the filter internally, so an
unscoped query does not compile. **Workspace-wide reads — search, the open-questions view and the inbox —
take the set of channel ids this user can see from the guard and narrow the query by it**
(`channel_id IN (…)`), never filtering the rows afterwards. The workspace filter is what confines
the trigram scan to one tenant (`idx_messages_search`); the channel set is applied to what it finds.

Like §7.3, the answer across a boundary is **404**. Every channel-scoped endpoint carries an
intra-workspace visibility test asserting it — and the guard raises **one value** for all four ways
to be refused (another workspace, private and not yours, soft-deleted, never existed), so they
cannot drift into telling them apart. Every scoped endpoint declares where it sits on this axis,
and one that names a channel cannot declare itself outside it (D-64).

**The rule is written whole, though Phase 0 creates only public channels.** A guard that is correct
only for the case that exists today stops being one the day the next case arrives, and here that
means showing somebody a conversation they were not in. The private cases are seeded directly and
tested now.

Two entry points, one rule: a caller holding a `WorkspaceContext` names a channel inside it, and a
route that names a channel and nothing else derives the workspace from the resource and verifies
membership first. Both refuse identically.

`platform/channels.ts`

---

## 8. Content Pipeline

### 8.1. Parsing, at write time

Parsing happens **once, on the server, when the message is written**. The parser produces
`metadata` (`SCHEMA.md` §6.4) and the `mentions` rows. The browser runs the same reading,
`packages/markdown`, to render (D-101).

It exists for three reasons: mentions are resolved once and stored as rows, `metadata` is derived
once rather than per feed render, and sanitisation happens in exactly one place. It does **not**
exist to save client render cost — the rendered output is not stored, and an earlier version of
this document claimed otherwise. The client renders the markdown and keeps each body's reading for
the session, keyed by its text — which changes exactly when `edited_at` does — and bounded, so a row
that mounts again is not read again (`features/content/reading-cache.ts`). Markdown remains the only
stored representation. (D-36)

1. Read the body with the one engine (D-101), inside its bounds; a body past them is not formatted
   and records no `metadata` — it is still sent and stored as typed.
2. Extract `@username` mentions → resolve against workspace members → `mentions` rows.
   **`@here` and `@channel` are rejected here**, structurally, not by convention. (D-12)
3. Record fenced code block languages → `metadata.codeLanguages`.
4. Detect GitHub PR/Issue URLs → `metadata.githubLinks`.
5. Sanitise by narrowing: the engine never recognises raw HTML, and the tree a renderer is given
   holds only the kinds the product draws, and links only to the addresses D-101 §2 allows. The same
   function runs where the browser renders. Markdown's image syntax stays unrecognised; a **link to a
   picture** (an `https` address whose path ends in `.png`, `.jpg`, `.gif` or `.webp`, up to three a
   message) is drawn under the words through the proxy, `GET /api/images` (#110,
   `docs/spikes/image-proxy.md`), never from its own host: the API fetches over
   `node:https` with a `lookup` that refuses the name unless every address is public unicast and
   connects only to what it checked, on a fresh connection, following no redirect, within a byte cap
   and five seconds, and serves its own WebP re-encoding — so no reader's address reaches the image's
   host and no address inside the network is reachable through it. It is charged to the reader's
   budget for costly reads — not the one they send with (D-81) — and only the fetch holds one of the
   node's four slots, with at most sixteen waiting for one: past that line a picture is not available
   now, the same 404 as any failure, rather than another connection held. **Accepted, stated:** a name
   refused by policy fails in the time DNS takes and a reachable host in the time it answers, so an
   attacker can tell which names resolve privately; and a public service that trusts this server's
   address can be sent a GET — to a name with a publicly trusted certificate, returning nothing but an
   image.

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
              ├─ hash the workspace and the URL (D-112)
              ├─ SELECT FROM link_previews WHERE url_hash = $1 AND expires_at > NOW()
              │     └─ hit  → return
              └─ miss → GitHub API with the WORKSPACE token (D-23)
                        ├─ 200 → upsert, TTL 5 min → return
                        ├─ 404 → cache the negative, TTL 1 h → return null
                        └─ anything else → log, hold off 1 min → return null
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

A pull request's `ciStatus` and `reviewDecision` (lower-case in the contract) are a second question,
asked of GitHub's GraphQL API with the same token — the parts as variables, never in the query
text — and folded into the card: the rollup of its last commit's checks (`ERROR` is a failure,
`EXPECTED` pending) and its review decision, each absent when GitHub says none. An issue is never
asked. If the second question fails the card is drawn without them, the failure is logged, and the
card is kept a minute instead of five, so they are asked for again soon; one pull request card is at
most two requests per five minutes per workspace (#423). The client
reads the links from the words with the server's engine (`metadataOf`) and draws no avatar, which is
an image on GitHub's host (#110).

---

## 9. Attachments

The rules are D-109's; this is the path through the code.

1. `POST /api/workspaces/:workspaceId/uploads` with the file's bytes (`API.md`) → the edge judges
   its type and length before anything is read → `modules/attachments/images.ts` re-encodes an
   image, or leaves a file as sent → `uploads.ts` stores it under an opaque key and checks the quota
   with its row → the `Attachment`, `message_id` still null.
2. The message is sent carrying those ids; the service links them and adds to
   `storage_used_bytes` in the same transaction.
3. Every page of messages carries each message's attachments, read in one query for the page
   (`messages/sets.ts`); a tombstone carries none.
4. Unsent uploads older than a day are swept by `bun run job sweep:orphans` (D-30), and the count is
   reconciled by `reconcile:storage`.

Downloads are always brokered by the API so membership is actually checked; storage keys are
never public URLs.

---

## 10. Errors, Observability, Testing

**Errors.** One `AppError` type whose `code` is a **discriminated union in `@purlay/types`**, not
a free string — so a client can handle it exhaustively and adding a code breaks the switch that
forgot it (D-47). Never leak internals to the client; never swallow an error to make a code path
look clean. A caught error is either handled or re-thrown — logging and continuing is prohibited.

**Logging.** One JSON line per event on standard output, written synchronously so a crash keeps
the lines that explain it. Every HTTP request and every socket frame is a scope with its own id —
the response carries it back as `x-request-id` — and every line written inside the scope carries
it, however deep the call, without any signature taking it (D-47, D-71). A request writes one line
when its response has gone; a failure the client is told nothing about is written with its cause.
Never logged: session tokens, `access_token_encrypted`, message content, email addresses — a list
in `platform/logging.ts` that every field and binding passes through, at any depth, before it is
written. A value interpolated into a message's text cannot be found that way, so a message is a
constant and variables go in fields.

**Executors are arguments.** Every service and repository takes its `Kysely<Database>` or
`Transaction<Database>` as a parameter rather than reaching for a module-level handle. This is what
makes one-transaction-per-test possible, and it is enforced by the same lint boundary as the
layering rule. (D-46)

**Health.** `/health` is liveness and touches nothing. `/health/ready` is readiness: the database answers, every migration is applied, and the identifier columns compare byte-wise (D-40); otherwise `503`, with the reason in the log and not in the response.

**Testing (D-21).**

| Layer | What it proves | Today |
|---|---|---|
| Unit | Service rules and the invariants in `SCHEMA.md` §11 | `*.test.ts` |
| Integration | Real PostgreSQL, real migrations, one per endpoint | `*.integration.test.ts` |
| **Tenant isolation** | **Every workspace-scoped endpoint returns 404 across tenants — mandatory, no exceptions** | `testing/cross-tenant*`, from `API.md` (D-63) |
| **Channel visibility** | **A workspace member who is not in the channel returns 404 — every channel-scoped endpoint, plus search, open questions and the inbox (D-34)** | `ingress/http/channel-visibility*` (D-64) |
| Message id | Non-v7, skewed and colliding ids are rejected; a same-sender retry is idempotent (D-33) | `message-id.test.ts`, `messages.integration.test.ts` |
| **Content safety** | **Every construct the product does not render is the characters that were typed; a link goes only where D-101 §2 allows; the engine never recognises what it is configured not to; no body reaches an engine failure, and one past the bounds is shown as typed (D-101)** | `packages/markdown/src/*.test.ts`; the rendering half with #43 |
| Permission | Every role-gated action, per role, and every role-gated endpoint in the table | `testing/permissions*`, `ingress/http/permissions*` (#74) |
| Realtime | Two sockets, ordering, ACK, reconnect replay, duplicate-send idempotency | `realtime/*.integration.test.ts` |
| Generated types | Regenerating `packages/db/src/schema.ts` from the applied migrations produces no diff (D-45) | `bun run db:check` |
| Architecture fitness | No module imports from `ingress`; every endpoint in `API.md` has a cross-tenant test; `OFFSET` never appears in a `messages` query; every cross-document reference resolves (D-47) | Lint and `scripts/`; the rest is #130 |
| Audit | Every administrative action writes exactly one `audit_log` row; no service issues `UPDATE` or `DELETE` against it (I-9) | With the audit log (#69) |
| Retention | The purge deletes nothing when `retention_days IS NULL` and never a message inside the window (I-10); erasure never removes a message (I-11) | Phase 2 |
| **Accessibility** | **`axe` clean on every component and every screen. A violation is fixed, never waived (D-52)** | Before the first screen (#139) |
| **Keyboard path** | **Every action reachable by mouse is reached by key, per screen (`UX.md` §7)** | With the screens (#139) |
| **Screen states** | **Loading, error and empty each render, per view. A missing state is missing specified behaviour (`UX.md` §8, D-53)** | With the screens (#139) |
| Visual regression | A snapshot per component and screen, in every theme that exists (D-52) | #139 |
| Budget | Bundle and idle RSS against `PRD.md` §5 block; latency budgets block on a regression against the previous commit (D-49) | #140 |

The gate is `bun run verify`, which CI runs too: typecheck with both compilers, lint, format, every
test through `test:all` held to the per-file coverage floor in `bunfig.toml`, the enforcement
demonstration and the document checks. No `any`. Every bug fix ships with a regression test.

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

**One operator-facing detail, decided now because it is invisible until it hurts.** The PostgreSQL
volume is mounted at `/var/lib/postgresql`, not at `.../data`: from 18 onward the data directory
sits inside the volume so that a later `pg_upgrade --link` does not cross a mount boundary.
Mounting the data directory works perfectly until an operator's first major upgrade — a problem we
would have created for them.

**One public origin.** `APP_URL` is the origin the browser uses. In development Vite proxies
`/auth`, `/api` and `/ws` to the API process so the two look identical to a browser — that is
built. In a deployment the API serves the built client from the same origin (`API.md` §8, D-102); the
demo and the browser tests reach it the same way, through the API. There is therefore no CORS to configure, the socket's `Origin`
check is an equality, and the session cookie's `SameSite=Lax` is the whole story (D-61).

**Still to come in the deployment.** The development `docker compose` runs the database and object
storage and nothing else; the deployable stack is below. Its **scheduler** container runs the CLI
jobs at fixed UTC times (#72, D-30; the schedule is `docs/CONFIG.md`'s). It ships wired by default: the known failure mode of
external scheduling is the cron nobody installed, and every run records its outcome in `job_runs`
(`SCHEMA.md` §9.2) so `purlay jobs:status` can report *last successful run* per job.

**Error tracking.** Off unless `ERROR_TRACKING_DSN` is set. When it is, whatever the logger writes at
`error` is also posted, cleaned as the log is, to a Sentry-compatible endpoint, with no vendor library;
it is bounded, drops under a storm and can never throw into the caller
(`apps/api/src/platform/error-tracking.ts`, D-96, D-44).

**Upgrading and rolling back** (the one home of this runbook; `CONFIG.md` points here). Every step below
was run, and the failure in the last-but-one paragraph was reproduced, not reasoned out.

1. **Take a backup first, and keep it until the upgrade has proved itself.** `scripts/backup.sh`, then
   check it the way a restore would: `scripts/restore.sh <dir>` into the default new database and bucket
   and `scripts/compare-databases.sh purlay purlay_restore`. Write down the `PURLAY_IMAGE` that is running.
2. **Upgrade by changing `PURLAY_IMAGE`** in `production.env` to the new digest (or commit tag) and running
   `docker compose -f docker-compose.production.yml --env-file production.env up -d --wait`. With
   `MIGRATE_ON_START=true` the new API container migrates when it starts; the old one drains (D-72), so
   clients reconnect rather than see an outage.
3. **Expect `/health/ready` to answer 503 for as long as the migration takes** — measured, about 18 s for a
   15 s migration with two replicas starting together. The proxy sends no traffic to a node that is not
   ready, and `--wait` returns when the API reports healthy, which is when to look at the site. A migration
   longer than the container's 30 s `start-period` shows the container as `unhealthy` while it runs; that is
   a number to raise in the compose file for a big one, not a failure.
4. **A migration that fails stops the node, loudly.** The API logs `migrating on start failed` with the
   cause and exits 1; compose restarts it, and it fails the same way until someone acts. It does not serve
   half a schema.
5. **An older image against a newer schema does the same, by design.** Start the previous image on a
   database that has since had a newer migration applied and it refuses: `corrupted migrations: previously
   applied migration <name> is missing`, `migrating on start failed`, exit 1 — and, without
   `MIGRATE_ON_START`, readiness stays 503 with the same reason. There is no down migration (D-86), so
   **rolling back is restoring the backup taken in step 1**, not starting the old image.
6. **To roll back:** stop the API (`docker compose … stop api`); restore the database alone —
   `scripts/restore.sh <dir> --database purlay --replace --no-bucket` (`--no-bucket` because attachments
   are only ever added and a schema migration does not touch them; the bucket is not empty, and a bucket
   import refuses that); put the old image back in `production.env`; `up -d --wait`. The database that was
   there is kept, renamed `purlay_before_restore_<time>`, until you drop it. Anything written after the
   backup is not in the restored database — that is what a rollback costs, and why step 1 is first.
7. **Key custody.** `ENCRYPTION_KEY` is in no backup, on purpose, and a restore onto a new server needs the
   same one. Keep a copy somewhere other than the server and other than the backups (a password manager, a
   sealed envelope). Lose it and the stored integration tokens (`github_integrations.access_token_encrypted`)
   cannot be read: people are asked to link GitHub again, and nothing else is lost. Changing it on purpose
   has the same consequence, and invalidates sign-ins in flight (the OAuth state is signed with a key derived
   from it), so rotate it at a quiet hour and tell people. The database password and the storage secrets are
   not custody problems: a rebuilt stack takes new ones from its `production.env`.

**Backups.** `scripts/backup.sh` writes a directory: a custom-format `pg_dump`, the bucket's objects with
a manifest of sizes and checksums, and a `SHA256SUMS`. `scripts/restore.sh` checks everything it can before it changes anything — the sums, that the dump
reads back, the target database and bucket — restores into a staging database, checks that, and only
then swaps it in by renaming, keeping what was there; by default into a new database and bucket. It
It is `0700`/`0600` and a failed backup removes its partial directory. And `scripts/compare-databases.sh` proves the
result is the same (D-95, D-44). `scripts/restore-rehearsal.sh` does all of it from nothing —
including after destroying every volume — weekly in CI. What it does not give: point-in-time
recovery, off-host copies, encryption.

**The production stack.** `docker-compose.production.yml` runs the API, PostgreSQL, Garage and Caddy
behind one origin with automatic TLS: only the proxy publishes ports, the API starts when its
dependencies are healthy and the proxy when the API is ready, and the file's only inputs are the
variables in `CONFIG.md` (D-94, D-73). The proxy compresses; the API does not (D-94). A test resolves it with `docker compose config` and checks
those properties rather than trusting the YAML.

**The image.** The API builds into a three-stage image whose runtime stage is distroless and runs as
a numeric non-root user with a read-only root filesystem (`Dockerfile`, D-92). `scripts/image-smoke.sh`
runs it against a PostgreSQL of its own on a private network in CI and checks liveness, readiness, the container's own health
check, the absence of a shell, and that `/` is the client's shell naming a script that is served and
cached for good; `image.yml` runs on every pull request (so it can be required), and on main builds the image once, pushes it by digest with provenance and an SBOM, smoke-tests that digest and only then tags it. The
middle stage builds the client; only its `dist` reaches the runtime stage, which sets `CLIENT_DIST` to it
(D-61).

**Migrations on start, for any number of nodes.** With `MIGRATE_ON_START=true` the process calls the
migrator after its listener opens. The migrator's advisory lock, polled without holding a transaction open
(D-86), makes nodes started together take turns; the others stay not-ready — `/health/ready` answers 503
while migrations are pending — until it is their turn and then find nothing to do. A migration that fails
exits the node with 1 (`apps/api/src/platform/migrate-on-start.ts`, D-93).

**Migrations and traffic.** A migration that alters a table takes a lock that has to be granted behind
every transaction already using it, and a send takes `messages` and then `channels`. Under heavy write
load the two can deadlock; the migrator retries a migration PostgreSQL ends that way, at most five
attempts, and says so in the log, but a retry makes the deadlock survivable and not free. Run migrations
at low traffic: a rolling deploy at a quiet hour, or `bun run db:migrate` before the new nodes take load (D-86).

**A restart is a reconnect, not an outage.** On SIGTERM or SIGINT the process drains: readiness
answers 503 at once, every socket is closed with `CLOSE_CODES.RESTARTING` (1012) so its client
reconnects and replays from its cursor, the listener stops accepting while requests in flight
finish, the pool closes, and the process exits — or, past a ten-second deadline, exits 1 and says
what was still open. `apps/api/src/lifecycle.ts`. (D-72)

Phase 3 introduces multiple API nodes behind a sticky-session load balancer and swaps in
`RedisEventBus`, `SharedPresenceRegistry` and `SharedRateLimiter`. Nothing above changes: the
three seams in §6 were placed for exactly this, and background work already runs outside the API
process (D-30), so no job needs a distributed lock.
