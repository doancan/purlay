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
| Mail | SMTP through `nodemailer`, pinned | `nodemailer` | Sign-in links only (D-138). No runtime dependencies of its own; built from a typed object, never a URL and a loose bag — the spike's first run got its options silently ignored that way; STARTTLS required past this machine — `docs/spikes/nodemailer.md` |
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

**Not in the stack, deliberately:** an ORM (D-20) · a Tauri shell, dropped by D-186 · any client-side
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
│   │       │   ├── auth/        the sign-in library (Better Auth) and what sits on it: sessions (token SHA-256 at rest)
│   │       │   ├── workspaces/  tenancy, membership, roles, Deep Work
│   │       │   │              ownership is a membership row, never a column (D-22)
│   │       │   ├── channels/    channels, DMs, membership, read state
│   │       │   ├── messages/    messages, threads, resolution, mentions
│   │       │   │              keyset on the id alone; OFFSET is a check, not advice
│   │       │   ├── attachments/ upload, thumbnails, quota, a channel's files
│   │       │   ├── notifications/
│   │       │   ├── search/
│   │       │   └── integrations/github/  unfurl, link_previews cache
│   │       ├── platform/        the bottom layer: config, clock, errors, tenancy, channel
│   │       │                  visibility, the EventBus seam, the transaction boundary
│   │       ├── testing/         fixtures every layer's tests may use; never imported by code
│   │       └── index.ts
│   │
│   └── web/
│       ├── worker/          the push worker (D-126): built alone to `/push-worker.js`, its own
│       │                    compiler project (the WebWorker library), importing nothing the page does
│       └── src/
│           ├── app/             providers (one tree, every port optional), the frame, the outlet,
│           │                    and deferred.ts: the deferred chunk — settings, image viewer, the
│           │                    overlays opened on purpose — fetched once the browser is idle (D-159, D-163)
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
  topic, `CHANNEL_STATE`, `CHANNEL_ADDED` and `WORKSPACE_UPDATED` — a workspace renamed, read again
  rather than patched from the frame (D-98, D-99, D-124). An edit and a delete are heard as
  `MESSAGE_REVISED` on the channel's topic: the words, the times and the mentions, at the message's
  version, never its reactions or thread (D-103). A rename or a new topic is `CHANNEL_UPDATED` on the
  channel's topic, at the channel's version; an archive and a leave are `ACCESS_REVOKED`, saying why
  (D-123). A pin or an unpin is `PINS_UPDATED` on the channel's topic, with nothing but the channel in
  it, and the client reads the pins again (D-130). A channel's incident declared or changed is
  `INCIDENT_UPDATED` on the channel's topic, with nothing but the channel in it, and the client reads
  the incident and the lists that mark it again (D-137). An earlier version of a message removed by its
  author is `MESSAGE_VERSIONS_UPDATED` on the channel's topic, with the channel and the message, and a
  client with its history open reads it again (D-135). A change of the person's own Deep Work is `DEEP_WORK_UPDATED` on their `user:` topic, so
  their other tabs draw it (#526); a change of their saved messages is `SAVED_UPDATED` there too, with
  nothing but the workspace in it, and the client reads what it shows again (D-128); a notification
  written for them, of any kind, is `NOTIFICATIONS_UPDATED` there, with nothing but the workspace, and
  an open inbox reads it again (D-106); a channel starred or
  let go is `CHANNELS_UPDATED` there, and the client reads that workspace's channels again (D-132). Typing is a `TYPING` frame
  each way (D-114): the client names a channel it can see and is answered with nothing; the room
  hears it only from a member — what a non-member types could not be sent (D-156) — and from a
  channel's box, never a thread's reply box (D-171); it hears who, and for how long, at most once per half window per person. Nothing says "stopped" — a
  listener forgets a person when that runs out or their message arrives. `ACTIVE` is the client's
  word that its page is in front of the person in a workspace: answered with nothing, heard only by the
  push sender, which holds that workspace's pushes for its window (D-143). Each frame joined the union
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

**The replay is of new root messages only; what else happened is read from the changes.** `SUBSCRIBE` replays
the root messages after the cursor that are not deleted. It does not replay an edit, a deletion, a reaction, a thread
reply, a resolved thread or a redaction made while the client was away. A client asks for those: for each channel it
shows, `GET /api/channels/:id/changes?since=<the asOf it holds>`, pages to the end, applies each message it is given
by id (a deleted one is a tombstone to show), and keeps the `asOf` of that walk. It takes its first `asOf` from the same
route asked with nothing, at the moment it loads a channel's history. A client with no `asOf` for a channel, or one
it does not trust, reads the history again. What the changes do not carry — the channel list, pins, memberships, the
inbox, unread counts — is read again after every acknowledgement, as the web client's `resync` does
(`apps/web/src/realtime/engine.ts`). **A message the retention purge deleted is not in the walk** (the job has no bus,
D-139 §3): a client that must not show one reads the history again after a purge. (D-194)

**A `SUBSCRIBE` is judged whole.** One channel the person can no longer see makes the whole frame
`ERROR CHANNEL_NOT_FOUND`, naming none: no `ACK`, no replay for the channels that were fine, and they
stay unsubscribed (D-34 — the answer for a channel one may not know about is the answer for one that
is not there). `ACCESS_REVOKED` went to the socket that was closed, and is not replayed. After that
error a client reads its channel list again, drops the channels it no longer has, and subscribes to
the rest.

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
own timeout, which for a half-open socket is minutes. The browser's own word comes first: an
`offline` event declares an open or opening socket dead at once, since a socket is not closed when
the network goes, and a send still waiting for its `ACK` stays sending and goes again on the
reconnect rather than failing on its deadline. `online` starts the backoff over — the next attempt
comes on the first rung's jittered wait, and an attempt hanging on the dead network is given up for
it — or, with a socket open, sends a `PING` at once to ask whether it lived through the gap. Neither
starts a connection that was not running (#626). The first `PONG` also measures the server's clock (D-33). A handshake the server refuses is indistinguishable in the browser from an outage, so
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
  N times the quota (D-25). **The number is decided (D-198, closing O-4)** — 10 frames/second with a
  burst of 60, measured against what a page sends (`bun run measure:frames`).
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
- **The cloud (`REDIS_URL`, D-201):** `redisBackplane` (`realtime/redis-bus.ts`) — the same
  `Backplane` over one Redis pub/sub channel. A node subscribes once and filters locally, so there is no
  window between "subscribed" and "listening" for a frame to fall into (the hub subscribes, then replays
  from the database: D-82); a publisher hears its own frame back like every node, so each frame is
  delivered once per node and every node sees one order. While Redis is away a node delivers to its own
  sockets; when it is back, a node that may have missed frames closes its sockets with
  `CLOSE_CODES.RESTARTING` so they replay from their cursors, which is the logic that already exists
  (D-190). Typing, who is online and the limiters that are keyed beyond one connection are shared the
  same way and fall back to this node's own answer (`realtime/redis-presence.ts`, `redis-limiter.ts`).
  Without `REDIS_URL` none of it is built.

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

The interface grows with its features (D-114): typing (`realtime/presence.ts`), and who is online
(`realtime/online.ts`, D-136) — told by the hub's own count of each person's sockets, offline only a
grace after their last closes, every change at a version that only grows; its reads are async. Phase
0–2: in memory, one node. Phase 3: the same interfaces over the shared bus — for typing, a person on
two nodes is announced once by each, a frame too many and never a wrong answer; **for online, one node
alone is wrong on two** (a person online on one is offline to the other), so the shared adapter comes
before a second node does (D-25, D-136 §5).

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

Sign-in is Better Auth's, mounted under `/auth` (D-179); what it is configured to do, and the
mechanisms of ours beside it, are `apps/api/src/modules/auth/better-auth.ts`.

1. `GET /auth/github` → the library makes the `state` (a row of its own, and a signed `__Host-`
   cookie) and the browser is sent to GitHub. Scopes: **`read:user user:email`**, nothing more.
   Repository access belongs to the workspace-level integration token (D-23), never to a member's
   sign-in. (D-38)
2. `GET /auth/callback/github` (the library's callback under its base path, `SIGN_IN_CALLBACK`) →
   verify `state`, exchange the code, fetch the profile **and `/user/emails`**, every call with a
   deadline.
3. Resolve identity (D-38, D-179 §5): take the primary **verified** email, or refuse. The account is
   found by the library's record of the GitHub account (`accounts`); otherwise an account whose
   own address is the same **and verified** is the same account and is joined to GitHub; one whose
   address is unverified is never linked. A new account is made only where sign-up is open. Purlay's
   own columns are then written for it — `github_id`, `github_login` (D-169) and, for an account
   GitHub made, a `username` from the login, shaped and suffixed on a collision, and the display
   name; an account made by email keeps its own names (D-176).
4. The session is the library's: a random token whose **SHA-256** alone is stored in `sessions`
   (D-11, our hashing plugin), lasting `SESSION_TTL_DAYS` from sign-in and never slid forward.
5. Set the session cookie — `__Host-purlay_session`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`
   (names in `apps/api/src/platform/cookies.ts`) — and spend the `state` cookie, on this and every
   other outcome. (D-62)
6. Any refusal on the way is a redirect to the sign-in screen with a reason, never a JSON body: the
   person arrived by navigation. The reasons are listed in `API.md` §2. (D-121)

`state` verification is not optional — without it the callback is a CSRF endpoint that logs
victims into an attacker's account. The cookie carrying it is **signed** with the library's secret,
itself derived from `ENCRYPTION_KEY`, and its value is kept server-side as well: a sibling subdomain
can write a cookie for this origin, so an equality check alone would still let an attacker supply
both halves (D-62). Every way the handshake can be wrong produces the same refusal.

**Connecting GitHub by hand is gone** (D-176, replaced by D-179 §5). An account made by email whose
address is unverified has no `github_id`, and a GitHub sign-in on its address is refused (step 3); one
whose address is verified is the account a GitHub sign-in on that address arrives in, linked by the
sign-in itself. Nothing is pressed, no second state exists, and the card *How you sign in* only reads
(`GET /api/me/sign-in`, `API.md` §2).

**Validating one.** The token is looked up by its hash, and a session resolves only while its row
exists and is unexpired, and it is owned by a user who has not been deleted — a soft-deleted account does
not keep a live session. Ending a session deletes its row, so there is no "revoked" state to consult. Every reason to refuse produces the same answer, so an unauthenticated
caller cannot learn from it whether a token was ever real or an account ever existed. `last_used_at`
is refreshed at most once an hour rather than on every request. (D-60)

**Signing in joins nothing.** A person enters a workspace by creating it or by an invitation link
(D-115); Phase 0's open join (D-37) is retired, and its variable is refused at boot.

### 7.2. WebSocket upgrade

The upgrade request carries the same cookie. The session is looked up **before** the socket is
bound; an invalid or expired session is rejected at handshake, never after. There is no
token-in-query-string path — query strings land in access logs.

**After the handshake, a connection lives exactly as long as its session.** Signing out and signing
out everywhere publish `SESSION_ENDED` on each ended session's topic; expiry is a timer set from
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

**A client that is not a browser** (the macOS application, D-186) meets the same upgrade with two things the
browser does for itself, set by the client: the session as an explicit `Cookie` header, and `Origin` equal to
`APP_URL` — D-39's check is an equality, and `GET /api/client` is where the client learns the value. It also
sends `X-Purlay-Client`; one below the served minimum is answered `426 CLIENT_TOO_OLD` at the upgrade, a status
the client can act on, where a socket that closes tells it nothing (D-190). A browser sends no such header and
is served.

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
| Rename the workspace | ✅ | ✅ | — |
| Configure GitHub integration | ✅ | ✅ | — |
| Connect a repository's feed to a channel they can see (D-134) | ✅ | ✅ | — |
| Create channels | ✅ | ✅ | ✅ |
| Archive channels (D-123) | ✅ | ✅ | — |
| Take somebody out of a channel they can see — an owner only an owner's (D-172) | ✅ | ✅ | — |
| Take another member (role `member`) out of a private channel they are in (D-172) | ✅ | ✅ | ✅ |
| See the workspace's storage and quota (D-173) | ✅ | — | — |
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
the trigram scan to one tenant (`idx_messages_search_folded`); the channel set is applied to what it finds.

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
   now, the same 404 as any failure, rather than another connection held. Its decode then takes at
   most one of the node's two decode slots, four waiting (D-170), so pictures never keep an upload
   waiting. **Accepted, stated:** a name
   refused by policy fails in the time DNS takes and a reachable host in the time it answers, so an
   attacker can tell which names resolve privately; and a public service that trusts this server's
   address can be sent a GET — to a name with a publicly trusted certificate, returning nothing but an
   image.

### 8.2. Rendering

- Code blocks over 12 lines clamp to 280px with a gradient mask, and carry a language badge,
  line count, expand/collapse, copy-raw and **Wrap lines** (a pressed toggle, the view only). A long
  line scrolls sideways under a thin, themed scrollbar that is always drawn (`scrollbar-thin` in
  `index.css`), as do a diff and a table, so a line cut at the edge always shows there is more.
- Syntax highlighting runs synchronously by default. It moves to a Web Worker **only where a
  measurement shows a dropped frame** — for a clamped 12-line block, the `postMessage`
  round-trip costs more than the highlight. (Corrects an earlier blanket rule.)
- A fenced `diff` or `patch` block is drawn as a diff (`content/diff-block.tsx`, D-133): read by a
  pure parser (`parse-diff.ts`) into files, hunks and numbered lines, unified or split by the
  reader's choice, unified alone on a narrow window; counted, copied raw and clamped as a code block
  is. No highlighting inside it: the colour is the change.
- A message nobody wrote — a repository's event (D-134 §6) — skips this pipeline: it is not parsed,
  so nothing in a title names anybody, and it is drawn from its `githubEvent`
  (`content/github-event.tsx`) as a sentence in the reader's language, every link built from the
  event's parts. Who a message is by is asked of `messages/author.ts` alone.

### 8.3. GitHub unfurling

```
Client detects a GitHub URL
      └─▶ POST /api/integrations/github/unfurl { url }
              ├─ no token → return null (a plain link at once, whatever is cached)
              ├─ hash the workspace, the token's version (its updated_at) and the URL (D-112)
              ├─ SELECT FROM link_previews WHERE url_hash = $1 AND expires_at > NOW()
              │     └─ hit  → return
              └─ miss → GitHub API with the WORKSPACE token (D-23)
                        ├─ 200 → upsert, TTL 5 min → return
                        ├─ 404 → cache the negative, TTL 1 h → return null
                        └─ anything else → log, hold off 1 min → return null
```

Negative caching matters: without it, one broken link pasted in a busy channel re-hits the API
on every render for every viewer. The token's version is in the key so a token replaced is asked
again at once: "not there" was what the old token could see, and an admin who fixed it should not
wait out the hour.

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
2. The message is sent carrying those ids; the service links them to the message and its channel,
   and adds to `storage_used_bytes`, in the same transaction.
3. Every page of messages carries each message's attachments, read in one query for the page
   (`messages/sets.ts`); a tombstone carries none.
4. `GET /api/channels/:channelId/files` → the channel's guard → `modules/attachments/files.ts` reads
   the channel's files by the channel they carry, newest message first (D-129).
5. Unsent uploads older than a day are swept by `bun run job sweep:orphans` (D-30), and the count is
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
Never logged: session tokens, `access_token_encrypted`, a feed's `secret_encrypted` and a delivery's signature (D-134), the server settings' GitHub client secret and relay address, read or sealed (D-179 §6), message content, email addresses, a device's
push endpoint and keys (D-126), a profile's status line (D-131), a sign-in link, its token and its
digest, and a mail's recipient and words — a relay's error is logged by its code alone (D-138 §8) — a list
in `platform/logging.ts` that every field and binding passes through, at any depth, before it is
written. A value interpolated into a message's text cannot be found that way, so a message is a
constant and variables go in fields.

**Metrics** (D-221). `GET /metrics` is Prometheus's text format, off unless `METRICS_TOKEN` is set and a
`404` like any unknown path to whoever does not hold it. One registry per process (`platform/metrics.ts`),
made by the composition root and handed in like every other dependency; it is recorded into at the
boundaries — the HTTP edge, the socket's rate refusals, the push sender, the mail ledger — and a module is
handed a `Counter`, never the registry. Label values are words the code spells: a route as registered, never
a path as sent; no id, address, name or content. The jobs run in another container, so their numbers are
read from `job_runs` per scrape, bounded, and a read that fails leaves the rest of the page.

**Executors are arguments.** Every service and repository takes its `Kysely<Database>` or
`Transaction<Database>` as a parameter rather than reaching for a module-level handle. This is what
makes one-transaction-per-test possible, and it is enforced by the same lint boundary as the
layering rule. (D-46)

**Health.** `/health` is liveness and touches nothing. `/health/ready` is readiness: the database answers, every migration is applied, and the identifier columns compare byte-wise (D-40); otherwise `503`, with the reason in the log and not in the response. It is public — an uptime monitor points at it — so its answer is reused for a second and one check runs at a time however many ask (`recentReadiness`, #636); draining is decided before it, so a shutdown is never hidden behind a cached `ready`.

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
| Retention | The purge deletes nothing when `retention_days IS NULL` and never a message inside the window (I-10); what a purged message added is taken back, its files' bytes once under two runs at once, and a reply racing it is `404` (D-139 §2); erasure never removes a message (I-11) | `modules/retention/purge*.integration.test.ts`, `ingress/http/retention-race*`, `modules/users/*erasure.integration.test.ts`, `ingress/http/erasure-race*` |
| Export | An export holds exactly its workspace's rows — not one id of another's — every person they name and nobody else, a former member without their address, no secret, and one consistent snapshot; every table and column of the catalogue is decided on (D-140) | `modules/export/*.integration.test.ts`, `ingress/http/exports.integration.test.ts` (an owner's: once, the channels they can see, no address) |
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
(`apps/api/src/platform/error-tracking.ts`, D-96, D-44). An error that escaped every handler — a
rejection nobody awaited, an exception from a timer or a callback — is logged once and reported as
urgent (one slot past the tracker's bound, so a storm of ordinary reports cannot crowd it out), new
work stops at once (readiness says no, sockets are told to come back), the tracker is flushed within
two seconds, and the process exits 1 for its container to restart; a shutdown that was draining when
it happened exits 1 too. The API and the scheduler both (`installCrashHandlers` in `lifecycle.ts`,
#634). Nothing is left running half-alive. The scheduler and each job process are tracked
the same way, through the same `errorTrackingFor` (#635).

First installation and runner configuration are in [DEPLOY.md](DEPLOY.md).

**Deploying is a script now** (D-185): on the team's server, a merge to `main` does steps 1 and 2 below by
itself after the image workflow succeeds, pulls the published image by digest and tries it before the switch,
and checks in the end that the API and the scheduler run the published commit (`scripts/deploy.sh`, started by the `deploy` workflow on the server's runner). When
that is not so, it goes back by steps 5 and 6. By hand, on any server with the same layout:
`DEPLOY_ROOT=… IMAGE_REPOSITORY=ghcr.io/<owner>/<repo>-api scripts/deploy.sh <full commit hash>` from a checkout of that commit. The deployment directory
holds `releases/<8 hex>/` (one per deploy, and the running one must be one of them), the `current` link to the
running one, `backups/`, the env file (with its previous copy as `.prev`) and `deploys.log`, one line per deploy,
rollback or refusal. A deploy that was cut off after it switched leaves `.switching`, and the next deploy refuses
to start until someone has looked at the site and removed it. The steps below stay, because they are what the
script does and what to do when it exits 2.

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
   a number to raise in the compose file for a big one, not a failure. If `--wait` gives up on it, what
   waits for a healthy API — the proxy, the scheduler — may not have been started: once `/health/ready`
   answers, run the same `up -d --wait` again, which starts them and changes nothing else (#637).
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
   has the same consequence, and signs everyone out and invalidates sign-ins in flight (the sign-in library's
   secret, which signs its session cookie and the OAuth state, is derived from it), so rotate it at a quiet
   hour and tell people. The database password and the storage secrets are
   not custody problems: a rebuilt stack takes new ones from its `production.env`.

**Backups.** `scripts/backup.sh` writes a directory: a custom-format `pg_dump`, the bucket's objects with
a manifest of sizes and checksums, and a `SHA256SUMS`. `scripts/restore.sh` checks everything it can before it changes anything — the sums, that the dump
reads back, the target database and bucket — restores into a staging database, checks that, and only
then swaps it in by renaming, keeping what was there; by default into a new database and bucket. It
It is `0700`/`0600` and a failed backup removes its partial directory. And `scripts/compare-databases.sh` proves the
result is the same (D-95, D-44). `scripts/restore-rehearsal.sh` does all of it from nothing —
including after destroying every volume — weekly in CI. **Point-in-time recovery** is opt-in (`WAL_ARCHIVE=on`): a base backup beside the dump, an archive of
the WAL, and `scripts/restore-pitr.sh`, which recovers into a new instance to a named time and hands back a directory
that `restore.sh` applies; rehearsed end to end in the same workflow (D-202, `CONFIG.md`). What none of it gives:
off-host copies by itself, encryption.

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

The cloud runs several API nodes behind a sticky-session load balancer, with `REDIS_URL` set so that
the bus, presence and the limiters are shared (D-201). Nothing above changes: the three seams in §6 were
placed for exactly this, and background work already runs outside the API process (D-30), so no job
needs a distributed lock. The balancer's configuration is #115's, not this section's: a socket lives on
the node that accepted it, which is why the per-connection frame limiter stays in that node's process
(D-201), and why a node that loses its Redis sends its sockets back to replay rather than leaving them
silent. A node reports ready only after it has reached Redis once; a node that has, and loses it, serves
on, degraded, and says so in its log.


**Thread knowledge (D-204).** ThreadSummary optionally includes knowledge; old rows omit it. A message page hydrates root metadata and bounded live-answer previews in one batched join. Metadata writes advance both knowledge_version (editor concurrency) and state_version (event ordering), so the existing changed_at trigger includes them in reconnect replay. THREAD_UPDATED carries the additive summary. Answer revisions update previews in held client lists; deleted roots drop decision metadata. Saved searches are database-backed personal filters; no new event, scheduler or external service is introduced.
