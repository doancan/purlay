# Purlay — Changelog

Notable changes, newest first. Releases get their own file: `docs/changelog/v{x.y.z}.md`.

---

## Unreleased

### Chore — 2026-10-09: every Action is pinned to a commit, and a test says so

- `actions/checkout`, `oven-sh/setup-bun` and `actions/setup-python` were pinned to tags their
  owners can move. Each is now a full SHA with its version in a comment, resolved and checked
  against the tag with the API; `scripts/workflow-pins.test.ts` fails any `uses:` that is not
  (#247, D-91). Dependabot's github-actions ecosystem keeps proposing the next SHA.

### Fix — 2026-10-09: two processes migrating at once no longer deadlock

- A starter waiting for the migration lock was a transaction to PostgreSQL, and `CREATE INDEX CONCURRENTLY`
  waits for those: one of two simultaneous starters died with `deadlock detected`, every time. The lock is
  now polled with `pg_try_advisory_lock`, so a waiting starter is idle between attempts. Reproduced first
  (10 of 10 runs red), then 20 of 20 green; replacing the poll with the blocking lock turns it red again
  (D-86, #231).

### Refactor — 2026-10-09: the `/api/me` query is a module's

- `readMe` no longer holds a raw query; `meOf` in `modules/workspaces` does (#245, D-47).

### Refactor — 2026-10-09: replay budgeting is a module; the casts that hid the frame union are gone

- Replay caps and the cursor floor moved from `realtime/router.ts` to `modules/messages/replay.ts`.
  `frame()` can no longer pair an event with another event's data, and the timer handle is typed.
- Joining a private channel or a DM you are in answers 404; that branch is now tested (#245, D-47).

### Refactor — 2026-10-09: test scaffolding moves to `src/testing/`

- `ingress/http/testing.ts`, `fixtures.ts` and `cross-tenant.ts` are now `testing/doubles.ts`,
  `signed-in.ts` and `cross-tenant.ts`. The cross-tenant table finds `docs/API.md` from its own
  location instead of the working directory (#245, D-47).

### Refactor — 2026-10-09: sign-in and session resolution are modules; ingress only translates

- `completeSignIn` and the session-end fan-out left `ingress/http` for
  `modules/auth/sign-in.ts` and `platform/events.ts`. A cookie header becomes a session in
  one function used by the HTTP guard, the hub and the socket admission, and the cookie definitions
  moved to `platform/cookies.ts`, so `realtime` no longer imports `ingress` (#245, D-47). Behaviour unchanged.

### Fix — 2026-10-09: the database refuses a message in the wrong tenant

- A message whose channel was in another workspace, a reply in another channel than its parent, a read
  position in another channel, a message id that was not a UUIDv7, and a DM key of `garbage` were all
  accepted. They are composite foreign keys and two CHECKs now, each with a test that attempts the violation
  and expects the constraint by name. Added `NOT VALID` and validated outside the transaction: on 1,000,000
  messages the slowest read during the migration was 6 ms and the slowest write 57 ms (#242, D-90).
- `SCHEMA.md` §11 says which invariants stay with the service, and why.

### Fix — 2026-10-09: deleting a message or a channel is no longer a table scan per row

- On 1,000,000 messages, deleting 100 took 4.8 s and deleting one channel did not finish in 60 s: the
  foreign keys on `messages` and `channel_members` had no index to be enforced with. Every foreign key
  column now has one (built concurrently): the same deletes take 8.7 ms and 90 ms. A test reads the catalogue,
  so a future table cannot forget (#241, D-89).
- `idx_workspaces_slug`, which duplicated the unique constraint's index, is gone. The search index's cost
  was measured and is written down: 15 to 25 microseconds a message, and it stays.

### Fix — 2026-10-09: a send no longer rewrites the channel row's indexes

- Every send updated `channels.last_message_at`, which was in `idx_channels_workspace`: of 2,000 sends, none
  was a heap-only update and the indexes tripled. The column left the index (migration `0008`); the same
  2,000 sends made 1,999 HOT updates and the indexes did not grow. The update is also monotonic now, and
  skipped when the message is not the newest (#244, D-88).
- A retried send announces the stored message again, on purpose, and a test says so.

### Fix — 2026-10-09: a socket frame that finds no database connection says so

- A `MESSAGE_SEND` or `SUBSCRIBE` that waited out the pool was answered `INTERNAL`; it is now the
  `DATABASE_UNAVAILABLE` frame HTTP already used, so a client may retry it (D-87).

### Fix — 2026-10-09: the connection pool fails fast and says what is wrong

- With a pool of two, a third query waited **7,612 ms** for a connection to free. It now waits at most
  3 s and fails with `DATABASE_UNAVAILABLE` (`503`), carrying no detail. Every connection also has a
  30 s statement timeout, a 15 s idle-in-transaction timeout and `application_name = purlay-api`; an
  idle connection the server drops is reported instead of ending the process (#243, D-87).
- `DATABASE_SSL_CA_FILE` trusts a private or managed certificate authority.
- `purgeDeadSessions` removes expired and revoked sessions in bounded batches. The scheduler is #71.

### Fix — 2026-10-09: readiness notices an edited or missing migration

- `/health/ready` now answers 503 when an applied migration's file was edited, has gone, or sorts out of
  order, the same states the migrator refuses to run past (D-86). A database from before checksums existed
  is still ready.

### Fix — 2026-10-09: a connection failure is written with what failed

- `pg` throws an `AggregateError` with an empty message when a host resolves to several addresses and
  none answers, and the log wrote `"message": ""`. It now writes every nested error with its message,
  and any error's system code (`ECONNREFUSED`, `23505`) as `errorCode` — not `code`, which stays on the
  never-logged list.

### Fix — 2026-10-09: a migration can leave its transaction, and an edited migration is noticed

- `0007` said `NOT VALID` then `VALIDATE` "lets writes continue". Inside the migrator's transaction it did
  not: on 1,000,000 messages a concurrent `SELECT` hit its statement timeout while the validation ran.
  A file can now opt out with `-- purlay: no-transaction`, and the same migration then delayed no `SELECT`.
  `CREATE INDEX CONCURRENTLY` becomes possible (#240, D-86).
- Each applied migration records its checksum; an edited, missing or out-of-order file stops the migrator
  before anything runs. `db:migrate` reads `DATABASE_SSL` like the application.

### Feature — 2026-10-09: a membership or session change ends delivery on every node

- A revoked session closed its sockets only on the node that handled the sign-out; a removed member
  kept receiving a channel on an open socket while HTTP answered 404; a deleted user's sockets lived
  on (#238, #203). Three bus events now carry these: `SESSION_ENDED` on `session:` and `user:`
  (`account-deleted`), and the new `ACCESS_REVOKED`, which unsubscribes the channels and leaves the
  connection open (D-85).
- Shown with two applications sharing one backplane and real sockets: sign-out on one closes the
  socket the other holds, and a removal published while a subscription is being authorised still
  ends it, because a subscription is now made before its channels are authorised.

### Fix — 2026-10-09: a socket's frames are handled in order, and a drain waits for them

- The framework started a handler per frame and did not wait for the last: a fast `UNSUBSCRIBE` was
  overtaken by a slower `SUBSCRIBE` (reproduced: the client kept receiving), and a frame still reading
  the database could meet a closed pool at shutdown. Frames now run one at a time behind a queue of 32;
  a connection that fills it is closed with the new `TOO_BUSY` (1013) (#237, D-84).

### Fix — 2026-10-09: one socket's failure no longer costs the others a frame

- The bus delivered in a bare loop: a send that threw stopped every later subscriber from receiving
  a message that was already committed, and surfaced as an error to the publisher. Each delivery is
  now isolated and a failure is logged with the socket's id, never the frame (#237).
- What a closed socket leaves behind is asserted on sizes: the hub, the bus and the limiter return to
  zero through the running server, and the expiry timer is shown cancelled on close. (The timer was
  already cancelled; it had no test.)

### Fix — 2026-10-09: a subscription is made before its replay is read

- A message committed between the replay read and the subscription was in neither, and the client's
  cursor moved past it. The socket is now subscribed first, live frames are held until the replay is
  written, and a message in both is sent once (#237, D-83). The bus also kept an empty entry for every
  socket that unsubscribed; it no longer does.

### Fix — 2026-10-09: a client's mistake is never a 500

- A body that is not JSON, a lost race for a workspace slug or channel name, and a GitHub login or
  display name longer than its column all answered `500`. They are now `400 VALIDATION_FAILED`,
  `409 *_TAKEN` and a shortened stored name, mapped in `refusalFor` and the identity rules
  (#233, D-78). A unique index nobody listed still answers `500`.

### Fix — 2026-10-09: a request that writes twice writes both or neither

- Creating a workspace, creating a channel and signing in each made several writes on the pool, so a
  failure between them left an ownerless workspace (slug taken for good), a nameless channel, or an
  account without a session. They now run in one transaction, and the services that write twice
  accept only a `Transaction` — the pool no longer compiles (#232, D-77).
- The test that proves it makes the second write fail on a cloned database and finds the first gone;
  before the fix it found it still there.
### Feature — 2026-10-09: HTTP routes are rate limited, and a session records where it started

- `/auth/*` is limited per client address and every mutation under `/api/*` per signed-in user, at
  the socket's budget, so `POST /messages` is no longer the unthrottled way in. A refusal is `429`
  with `RATE_LIMITED` and `Retry-After`. Numbers provisional (O-4). `TRUST_PROXY` is read: without
  it `X-Forwarded-For` is ignored. `sessions.ip_address` is written at sign-in (D-81, #235).

### Feature — 2026-10-09: the HTTP edge is bounded

- A JSON body over 64 KiB is refused with `413` by the server before it is read (a 60 MB body was
  parsed and answered `200`). A mutation from another origin is `FORBIDDEN`, logout included. Every
  response carries `nosniff`, referrer, framing and cache policy, and HSTS over https. A well-formed
  inbound `x-request-id` is kept as a label (D-80, #234).

### Fix — 2026-10-09: configuration refuses an unsafe production

- `ENCRYPTION_KEY` is decoded: 32 bytes, not one repeated value. Production refuses the public
  development key (which was itself 33 bytes), `DATABASE_SSL=false` without
  `DATABASE_ALLOW_PLAINTEXT=true`, and an `APP_URL` that is not `http`/`https`. Every refusal names
  its variable and never prints a value (D-79, #236).

### Chore — 2026-10-09: the browser has a place to read the clock

- `apps/web/src/system-clock.ts` is the one file in the client that reads the time, exempted by name
  in `eslint.config.mjs` the way `platform/clock.ts` is for the API; everything else takes a `Clock`.
  `verify:enforcement` now also shows a neighbouring web file is still refused (#136).

### Fix — 2026-10-09: the client notices a dead socket and stops retrying a refusal

- A half-open socket (sleeping laptop, dead NAT) read `open` for minutes. The client now pings after
  25 s of silence and treats 15 s without any frame as dead, reconnecting at once (D-82, #239).
- A signed-out user retried every 30 s forever, because a refused handshake is a 1006 like any outage.
  After three attempts that never opened, the client asks `GET /api/me` and stops on a 401.
- An event the client does not know is ignored instead of looping the connection through close and
  reconnect during a rolling deploy; `parseServerMessage` replaces `parseServerFrame`.
- The first `PONG` now feeds the server clock, and `start()` works again after `ended`.
- `ARCHITECTURE.md` §5.4 states the cursor caveat: a live frame does not move the cursor past a
  replay whose HTTP continuation is unfinished; the connection exposes `pendingContinuations` and
  `continuationDone` so the store can honour it.

### Chore — 2026-10-09: the dependency audit blocks, and four of the five findings are fixed

- `bun audit fix` moved `brace-expansion` 5.0.9 to 5.0.12 and `source-map-js` 1.2.1 to 1.2.2, within
  range, which clears three high and the moderate finding (#247). The audit is a job of its own that
  fails at high severity (`bun run audit:gate`), weekly as well as on every change.
- **The fifth cannot be fixed.** `braces` (through `kysely-codegen`, a development tool) has no
  patched release at all — the advisory lists none. It is in `scripts/audit-allowlist.json` with the
  reason and an expiry; the gate fails on an expired entry and on an entry that matches nothing.

### Chore — 2026-10-09: licences are checked, and the repository has a disclosure path

- `bun run check:licenses` reads the installed dependency tree and fails on a licence that cannot
  ship in an AGPL-3.0 distribution — an allow-list, so a licence nobody has heard of fails rather
  than passes (243 packages today: MIT, Apache-2.0, BSD, ISC, MPL-2.0, Python-2.0, BlueOak). It is a
  workflow of its own (#247).
- Every workspace manifest now declares `AGPL-3.0-or-later`. That is what `NOTICE` grants ("version 3
  ... or any later version"); `LICENSE` is the licence text and does not choose, and a test binds
  the manifests to `NOTICE`.
- `SECURITY.md` (private reporting, supported versions, response targets one maintainer can keep) and
  `.github/CODEOWNERS`.

### Chore — 2026-10-09: CodeQL scans the code, with the least token it can have

- A `codeql` workflow analyses JavaScript and TypeScript on every pull request, on main and weekly
  (#247). The repository is private and code scanning needs Advanced Security there, so results are
  kept as an artifact and the job fails if the SARIF has any result; they upload to the Security tab
  as soon as the repository is public. `scripts/workflow-permissions.test.ts` fails a workflow whose
  top-level token grants more than read.

### Fix — 2026-10-09: the local object store is Garage, and `bun run db:up` works on a clean machine

- MinIO's images are no longer published, so `db:up` failed anywhere they were not cached (#183).
  Garage replaces it after three stores were run against the operations attachments need; two passed.
  Its image has no shell, so `scripts/storage-init.sh` creates the layout, the bucket and the
  development key, and fails if the published port does not refuse an anonymous read.
- `MINIO_PORT` and `MINIO_CONSOLE_PORT` become `STORAGE_PORT`; there is no console.

### Feature — 2026-10-09: the client generates ids against the server's clock

- A laptop whose clock is 90 seconds slow was refused by D-33's window; one 10 seconds fast would have
  pinned its messages above everyone's. The client now derives an offset from the first `PONG` and
  generates against the corrected time (#21). Until that `PONG` arrives it uses the local clock,
  and a send the server refuses surfaces as `failed` with a retry.

### Research — 2026-10-09: the image pipeline is already in the runtime

- **`Bun.Image` makes thumbnails with nothing installed**, on macOS and in a Linux container, with
  EXIF removed from every output and a decompression bomb refused by default. The spike was meant to
  choose among native libraries and found none was needed (#6, D-75).
- **`resize(width, height)` stretches.** Found with a half-red, half-blue source; a solid-colour one
  looked correct. Thumbnails use `fit: 'inside'`.
- **A truncated JPEG passes `metadata()`** and fails only when decoded, so an upload is validated by
  producing its thumbnail, not by reading its header.

### Feature — 2026-10-09: the client reconnects, and catches up from where it stopped

- A dropped socket is reopened after a jittered, capped backoff, and every reconnect resubscribes
  with the highest message id heard per channel, so the server returns only what was missed (#22).
  More than 100 watched channels are split across frames. A session that has ended is not retried.
- `parseServerFrame` in `@purlay/types`: the browser's check that what arrived is a frame the
  contract defines. A frame that is not one ends the connection rather than being guessed at.
- Not in this change, deliberately: the optimistic buffer and its ACK deadline, continuing a replay
  that was one page (`nextCursor`), and a heartbeat. Each belongs to the store above this layer.

### Research — 2026-09-09: what the frontend stack costs, before a screen exists

- **The declared stack is 69% of the declared budget with no product code**, imported eagerly.
  Split, the initial bundle returns to **43%**, leaving about 142 KB for the whole product. The
  budget is reachable — and only if splitting is a rule from the first screen, not a cleanup at the
  end. A budget check that arrives once five screens exist arrives with a violation already in it.
- **The highlighter's *engine* is the weight, not its grammars.** Shiki's JavaScript regex engine is
  53 KB gzipped lazily loaded; the WASM engine is smaller in JavaScript and **seven times larger in
  total** (36 KB + 232 KB of WASM). For a product where most messages carry no code block, that is
  the wrong trade. `ARCHITECTURE.md` §2 said grammars load lazily; the measurement says the engine
  is the sentence that matters.
- **Radix publishes no combobox.** D-52 named five primitives and four exist — found by installing
  them, not by re-reading the paragraph. The command palette is **O-7** now, with `cmdk` and a
  hand-built listbox as the two candidates and the argument for primitives applying hardest to
  exactly that component.
- The lint rule D-52 requires — *a raw value is an error* — **is available**: two plugins support
  Tailwind 4 and ESLint 10. Which one actually refuses an arbitrary value here is the spike #137
  owes before either enters the stack.

### Hardening — 2026-09-09: five places the documents and the code disagreed

A cross-check of what the documents publish against what the code does. Each finding was found by
**comparing**, not by reading — every document was individually consistent — and each now has a
check, because finding them by hand once is not a strategy.

- **`GET /api/me` was documented as Phase 0, had a response shape in the contract, and nothing
  served it.** A signed-in client had no way to learn who it was signed in as: the first thing every
  screen needs. Implemented (#176), and a check now compares the endpoints `API.md` publishes for
  this phase against the routes served, **in both directions** — it also found `POST
  /auth/logout-all` served while documented as Phase 1.
- **`/auth/logout-all` is Phase 0 now**, with the reason written down: *sign out everywhere* is the
  capability D-11 chose database-backed sessions **for**, so shipping the cost without it leaves the
  decision unpaid.
- **Five error codes could never be raised.** Four belonged to features that do not exist, and
  `SESSION_EXPIRED` was unreachable **by design** — D-60 made every session refusal the same code
  on purpose. A code a client is told to handle exhaustively and will never receive is a lie in the
  contract. Removed, and a check now requires every published code to have a call site. `413` and
  `429` left the status union for the same reason.
- **`?after=` was in the contract, validated, and silently ignored.** Worse, the socket's replay
  read the *newest* page and filtered it in JavaScript while its own comment claimed to be keyset —
  so a client away for longer than one page silently lost the **oldest** messages it missed, which
  are exactly the ones it needs. It is a range query now, and asking for older and newer at once is
  a `400` rather than a silent choice.
- **The sidebar put silent channels above active ones.** PostgreSQL sorts nulls *first* under
  `DESC`, so a channel nobody had written in outranked every one with recent activity — invisible in
  any test where no channel has messages.
- **Eight assertions demanded an empty database.** `withRollback` rolls back a test's own writes; it
  never claimed to empty anything. They passed because CI starts from nothing — and failed the
  moment the application had actually been run locally. Green in CI, red for the person building the
  product. Every query in an integration test now names what it is asking about, and a check
  refuses one that does not.

### Implementation — 2026-09-09: the socket

- **The bus, the admission and the router**, all framework-neutral, so the security gate and the
  protocol are tested against a real database without a server. What the transport adds is thin,
  and this is what it is thin around.
- **The origin is checked before the session is looked up** (D-39). `SameSite=Lax` does not
  reliably protect a handshake: another origin can open the socket and the browser may attach the
  cookie. A missing origin is refused too — a browser following the rules always sends one.
  Removing the check failed two tests.
- **One transaction, published after it commits, acknowledged after publishing** (D-35). A refused
  send publishes nothing, so nobody sees a message that was not written. The transaction boundary is
  a **dependency** rather than a call, for the reason D-46 makes every executor an argument: a
  function that opens its own transaction cannot be run inside the one the harness rolls back.
- **Subscribing is authorised per channel** — a socket cannot listen to a conversation it could not
  read over HTTP — and replays what was missed oldest-first by keyset, because ids are time-ordered.
- **The bus forgets a closed socket entirely.** A topic set that is never cleaned up grows with
  every channel anybody ever opened, and only shows up after a long uptime.
- **#174 opened for the two limits §5.5 states and nothing enforces**: the frame cap cannot be
  applied where the router sees the payload, because the framework parses JSON first — measured —
  and the rate limit is still O-4.

### Implementation — 2026-09-09: messages

- **The hot path, and all three of D-33's permanent failures.** A wrong version, a timestamp from
  the future or too far back, and a collision acknowledged as a send — each has a test, and each
  test was made to fail by removing the check it guards.
- **A collision discloses nothing.** The row it hit is read back and compared with the requester
  before anything is returned; a mismatch is `409` carrying neither the content, nor the sender, nor
  the channel. The same sender re-sending the same id in the same channel gets the **same message
  back**, which is what D-8 designed the client-generated id for.
- **Keyset, never `OFFSET`.** One row more than asked for answers *is there another page* by
  reading rather than by a second `COUNT`, and the last page says so instead of making the client
  ask again to find out.
- **The prohibition on `OFFSET` is a check now**, one of the fitness tests #130 collects, added with
  the code rather than after it. Its first version matched the *prose explaining the rule* in the
  file that obeys it — a check reporting a violation it had read in a comment. Comments are
  stripped first, and it still catches a real one.

### Implementation — 2026-09-09: what a message id is

- **The generator and the rule live together**, in the contract package, bound by a test that
  generates two hundred ids and validates every one. They are two halves of one fact — the client
  makes ids the server must accept — and separating them is how a window widens on one side only.
  Neither app may own it: `apps/web` cannot import from `apps/api`, and a copy in each is the
  duplication the rule exists to prevent.
- **A test that reads the value it is testing cannot catch a change to that value.** Widening the
  window from five seconds to sixty passed every test around it, because they all computed their
  offsets *from* the constant. Found by breaking it on purpose. The numbers are now asserted
  literally, and bound to the sentence in D-33 that decided them — changing either without the
  other fails.
- The shape check refuses a v4 id, which the contract's own `uuid` format accepts. That is the
  whole reason it exists: an id of the wrong version makes a channel's ordering wrong **forever**,
  because the value is the primary key and the pagination cursor.

### Implementation — 2026-09-09: channels

- **The four channel endpoints Phase 0 serves**, and the first place both guards meet: a channel
  named inside its workspace goes through the membership guard then the visibility guard; a channel
  named on its own derives the workspace from the resource and does both.
- **Two mandates, not one.** Every workspace-scoped endpoint carries the cross-tenant `404` (D-21)
  and every channel-scoped one carries the intra-workspace visibility `404` (D-34) — four tests,
  each also asserting the body matches the one for something that does not exist.
- **Listing narrows with the visible set** rather than filtering after the fact, which is the shape
  D-34 requires and what will confine the trigram scan when search arrives. Replacing it with a
  workspace-wide read on purpose failed the test.
- **Joining is idempotent.** A `409` on a second join makes a retry after a dropped response look
  like a failure, when the outcome asked for is already true.
- Names are unique **per workspace**, case-insensitively, among live channels only — so the same
  name in another workspace is fine, and deleting a channel frees its name.

### Implementation — 2026-09-09: channel visibility as a type

- **`ChannelContext`**, the second axis (D-34). Same mechanism as the tenant boundary: a brand keyed
  by a symbol its module does not export, so the only way to hold one is to have passed the guard,
  and asserting one is a lint error. The rule written for #12 covered it before it existed —
  matching by name rather than by a list was the reason.
- **The rule is written whole, though Phase 0 creates only public channels.** A guard correct only
  for today's case stops being one when the next arrives, and here that means showing somebody a
  conversation they were not in. The private cases are seeded directly and tested now; removing the
  membership check on purpose made a private channel visible to the whole workspace.
- **Four ways to be refused, one value.** Another workspace, private and not yours, soft-deleted,
  never existed — and a channel id that is not a UUID, which would otherwise be a `500` on the cast.
  The test compares the serialised responses and asserts there is exactly **one distinct shape**.
- **The lint rule caught the test that proves it.** Asserting a workspace context where a channel
  one was required is exactly what the ban forbids; the assertion is a `declare const` now, with no
  exemption anywhere.

### Implementation — 2026-09-09: workspaces

- **The four workspace endpoints Phase 0 serves**, each through the membership guard, each carrying
  the cross-tenant test `ARCHITECTURE.md` §10 makes mandatory — and asserting not only `404` but
  that the body is **byte-identical** to the one for a workspace that does not exist. Turning the
  guard's refusal into a `403` on purpose failed both.
- **`WORKSPACE_SLUG_TAKEN`** joins the closed error set. A slug is an address in a URL and the
  contract had no code for taking one twice; the nearest existing one was about channels.
- **Validation is this project's, not the framework's.** The framework's refusal echoes the
  submitted value and publishes the schema, so a typo comes back as a description of the server's
  own rules. The test asserts a submitted secret and the words `minLength` and `pattern` are all
  absent from the refusal.
- **I-2 is established here and guarded elsewhere**, stated rather than left implied: creation makes
  an owner and that is tested, and nothing in Phase 0 can then break it — changing a role and
  removing a member are both Phase 1. The guard belongs with the endpoints that can violate it,
  where it can be tested against something that tries.
- **`/api/*` requires a session**, in one place, with a missing and an invalid cookie producing the
  same `401`.

### Implementation — 2026-09-09: signing in with GitHub

- **The whole handshake**, driven end to end in tests against a real database with GitHub as a
  double: the redirect asking for exactly `read:user user:email`, the signed `state`, the code
  exchange, identity resolution, the session, and signing out — here and everywhere.
- **D-61** — **one public origin.** `CONFIG.md` said the callback registered with GitHub is
  `${APP_URL}/auth/github/callback` while `APP_URL` was documented as the *client's* origin and the
  API was a separate container. Every document was individually consistent and the combination did
  not work. Development is proxied so a browser sees what production shows it — which is the one
  place a topology difference is most expensive, because cookies and redirect URIs cannot be tested
  on a machine shaped differently from the deployed one. There is now no CORS at all.
- **D-62** — the `state` cookie is signed with a key **derived** from `ENCRYPTION_KEY`. Comparing
  the cookie to the query parameter is sound only while nothing else can write a cookie for this
  origin; a sibling subdomain can, and *cookie tossing* plus an attacker-chosen state signs the
  victim into the attacker's account. A second secret was rejected: the failure mode of *one more
  key* is the one nobody rotates.
- **Every collision D-38 names has a test**, including the likely one — GitHub omits the address
  from the profile for anyone who has not made one public, which is common among the developers
  this product is for. Removing the email-conflict check on purpose reproduced the silent account
  merge it exists to prevent.
- **A route group cannot be split out as a typed function.** The application's type is invariant in
  its routes, and the library's permissive alias launders `any` into every handler — 42 lint errors,
  which is the rule working. Handlers are framework-neutral now: a request in, a decision out.
- **A component test's DOM was leaking into the API's tests.** `bun test` runs every selected file
  in one process and imports files whose tests are all filtered out, so a top-level DOM
  registration fired during a run in which that file executed nothing — replacing `Request`,
  `Response` and `Headers` globally and breaking six API tests. Every file passed alone. Registering
  in `beforeAll` and unregistering in `afterAll` fixes it; adding only the `afterAll` did not,
  because the hook never ran. The reasoning behind choosing a per-file DOM over a global preload
  was right and the mechanism was not.
- **One test was silently flaky and was caught before it merged.** It tampered with the state by
  replacing the last character with `0`, which is a no-op whenever it already was `0` — a test that
  would have passed fifteen times in sixteen.

### Implementation — 2026-09-09: sessions

- **An opaque token, and only its hash in the database.** The claim is that a database dump hands
  over no live session, so the test looks for the raw token in **every column** of the row it
  created — a token that leaked into `user_agent` would pass a narrower assertion.
- **Every reason to refuse looks the same.** Expired, revoked, unknown, or owned by a deleted user
  all resolve to nothing. Otherwise an unauthenticated caller learns whether a token was ever real
  and whether an account ever existed — the 404-not-403 argument (D-21), one layer earlier. The
  deleted-user case is the one that would have been missed: a soft delete leaves the session row
  untouched, so without the join it keeps working.
- **D-60** — `last_used_at` is refreshed at most once an hour. This table is read on every request
  and every socket upgrade; writing it on every resolve turns the hottest read path into a write
  path to maintain a column whose only consumer is a device list nobody has built. Not maintaining
  it at all was also rejected: a column that never moves reads as data and is fiction.
- **The clock is a dependency**, in `platform/clock.ts` — the place the lint rule against reading
  it directly has been pointing at since it was written. It needs no exception to that rule.
- **The cookie's attributes are asserted, not trusted**, including the one that is invisible when
  wrong: the cleared cookie must match the original on everything a browser keys on, or sign-out
  stores a second cookie and the session survives.

### Specification — 2026-09-09: the stack table has to be true

- **D-59** — **the table says what is installed, and a test agrees.** D-57 stopped the next guess;
  it did nothing about the ones already in the table. A third column names the packages or compose
  services that make each row real, and every one is resolved against the manifests and
  `docker-compose.yml`.
- **The half that matters is the other direction.** `not yet` names its packages too and they must
  be **absent**, so a row cannot quietly stay behind once its thing is installed — the same drift
  pointing the other way, and the one nobody would think to look for. Proved by marking an
  installed package `not yet`, an absent one installed, and by removing the watcher from an
  `undecided` row.
- **It found one immediately.** *"A small CommonMark/GFM renderer"* and *"a sanitising serialiser"*
  are descriptions, not choices; they had no packages to name and nothing watching for the
  decision. **O-6** now, decided together in Phase 1 because the client renderer and the server
  sanitiser have to agree on what they accept.
- Generating the column was rejected: it would agree with the manifests by construction, which is
  the question being asked. The column has to be written and then contradicted by a check.

### Implementation — 2026-09-09: one command, two processes

- **`bun run dev` starts both.** It delegates to each workspace's own `dev` rather than repeating
  their commands, so there is one definition of how each application starts and the shortcuts
  (`dev:api`, `dev:web`) cannot drift from it. Bound by a test.
- Verified by running it: API `200` on `/health`, client `200`, from a single command.

### Implementation — 2026-09-09: the client boots

- **`bun run dev:web` serves and `bun run build:web` builds.** Vite, React and Tailwind at exact
  pins, wired the way the spike said Tailwind wants — its plugin and one line of CSS, no config
  file and no content array. Proved by the emitted rules, not by a class name in the markup:
  `.bg-slate-950{background-color:var(--color-slate-950)}`.
- **The measured floor: ~60 KB gzipped**, a quarter of the 250 KB budget, before a product screen
  exists. That number now sits beside the budget in `PRD.md` §5 rather than in a spike nobody
  re-reads. It is *smaller* than the spike's 82 KB because the spike installed things the client
  does not need yet — which is D-57 paying for itself.
- **The component-test DOM is registered per test file, not globally.** A `bunfig.toml` preload
  would install a DOM into every suite in the repository, including the ones where a dependency
  that feature-detects `window` would quietly take its browser path. The cost is that the global
  `screen` cannot work — `@testing-library/dom` binds it before any test file runs — so lint
  refuses that import and points at the measurement.
- **`bun x` from the wrong directory silently downloaded an unpinned Vite** and built with it. It
  succeeded, which is the problem. A check now refuses a script naming a tool its own manifest does
  not install.
- **The list of TypeScript projects is derived from the solution config**, not written down. The
  hand-written one fell behind within the hour: a tooling project was added and the check that
  compares what the compiler sees to what the linter sees reported a file nothing compiled.

### Implementation — 2026-09-09: the API is a process

- **It serves.** `bun run dev:api` starts ElysiaJS, `GET /health` answers `200`, an unknown route
  answers the error envelope rather than the framework's default, and a missing variable makes the
  process **refuse to start** — every problem at once, with secret values withheld.
- **One error handler, and three of its branches exist because a spike found the trap**
  (`docs/spikes/elysia.md`). A framework validation failure is not an `AppError`, so a handler
  branching only on `instanceof AppError` would have sent every `400` to the catch-all and told a
  client that mistyped a field the server had broken. The framework's own validation body echoes
  the request and publishes the schema; it is replaced entirely. Both were verified by removing the
  branch and watching the test fail.
- **`ROUTE_NOT_FOUND`** joins the closed error set: the contract had no code for *no such route*,
  and the nearest one would have been a lie.
- **The application returns the surface its caller uses, not the framework's type.** Annotating it
  as the bare `Elysia` does not compile — the type is invariant in its routes — and letting it
  infer puts every route's accumulated type into a committed `.d.ts`. Naming `handle` and `listen`
  answers both and keeps the framework's types out of everything above ingress.
- **No database handle is built yet**, because nothing needs one: liveness must answer while the
  database is down. It arrives with the first route that needs it.

### Specification — 2026-09-09: two claims finally run, and the rule that follows

- **D-57** — **a choice that has not been run is not a choice.** Three defects in a row had one
  shape: a branded type that could never have compiled (D-54), a task runner in the stack table
  that was never installed (D-55), a framework version named while nothing had installed the
  framework (D-56). The count, taken before fixing it: **19 stack rows, 6 ever run.** A tool now
  enters §2 on a record in `docs/spikes/` carrying the date, the versions actually resolved, the
  real output, and what had to be **loosened** — with "nothing" said out loud, because silence
  there is indistinguishable from not having looked. `CONTRIBUTING.md` §6.7 states it.
- **The two riskiest claims were run.** ElysiaJS and the whole web client stack both hold under
  this repository's strictness with **nothing loosened**. Both found things the documents did not
  know: ElysiaJS's own declarations produce 104 errors with `skipLibCheck` off, so its
  compatibility is contingent on that flag (now on D-20's risk row); the web skeleton spends a
  third of the bundle budget before a product screen exists; `happy-dom` alone cannot render a
  component; and one headless primitive costs about 28 KB.
- **D-58** — **what the client sends refuses what it did not declare.** Measured, not assumed: an
  undeclared property returns 200 and is silently dropped. Every shape a client sends is now
  closed, nested payloads included, and the set is derived from `ClientFrame` rather than listed —
  a new frame cannot escape by not being added to a list. Responses stay open on purpose.

### Specification — 2026-09-09: versions leave the documents

- **D-56** — **a version is a fact, so it lives in the manifest and nowhere else.** `ARCHITECTURE.md`
  §2 named versions beside choices. Two were bound to reality by a test; the third could not be,
  because nothing had installed the thing. The table was asserting a fact about a repository it had
  never looked at. §2 now names choices and never numbers, and `check-docs.py` — which already
  refused a version outside its owners — has stopped exempting it. It caught the paragraph
  explaining the rule, which named two versions while doing so.
- **Every dependency is pinned exactly.** The repository was mixed, with no rule written for which
  was which. A caret range is the polite form of *I do not know which version this is*; a pass from
  a differently-resolved tree is "green in one state is not green" one layer down. Checked, and the
  check was made to fail on purpose.
- The test binding the database image to a major written in §2 **lost its subject** and was
  replaced. The image tag is the fact; there is nothing left to bind it to.

### Specification — 2026-09-09: three claims the documents made and the repository did not

- **D-55** — **Bun workspaces are the build orchestration; there is no task runner.** The stack
  table listed Turborepo and accepted the cost of maintaining its configuration. Nothing was ever
  installed: no `turbo.json`, no `turbo` in any manifest. A table describing a repository that does
  not exist is worse than either choice. Resolved by deciding rather than by installing, with the
  trigger for revisiting written down instead of implied.
- **D-47 named the wrong owner.** Its text sent readers to `CONTRIBUTING.md` §5 for the required
  test matrix — the copy D-21 was amended to remove, and which §5 itself says lives in
  `ARCHITECTURE.md` §10. The reference resolved, so the consistency check passed: a section number
  can be right while the sentence around it is wrong.
- **`CONTRIBUTING.md` §5 said the same thing twice**, once as bullets and once as a paragraph under
  them. Removed rather than reconciled.

None of the three could be caught by what exists today. #156 covers the class the first one belongs
to: the table has to say which tools are installed, and a test has to agree.

### Implementation — 2026-09-09: the tenant boundary became a type

- **D-54** — a context is branded by a **module-private symbol key**, and asserting one is a lint
  error. The form `ARCHITECTURE.md` §7.3 documented — `readonly __brand: unique symbol` — is
  uninhabited: in property position it names a symbol no expression has, so not even the guard
  could have produced one, and every compile-time proof that a caller cannot forge a context would
  have passed because nobody could make one at all. The mechanism would have shipped with its
  escape hatch at the only place that must not have one.
- **`apps/api/src/platform/tenancy.ts`** — the membership guard, the sole producer of a
  `WorkspaceContext`. One refusal serves both "no such workspace" and "not your workspace", so the
  two are indistinguishable by construction rather than by two branches kept in step. A
  `:workspaceId` that is not a UUID takes the same refusal — handed to PostgreSQL it raises on the
  cast, and the boundary would have answered 500 where it promised 404.
- **The enforcement demonstration now names its rule.** It asserted only that ESLint exited
  non-zero, which any unrelated error in the violating file satisfies — a demonstration that can
  pass for the wrong reason, in the script that exists to stop exactly that. Each violation now
  declares which rule must reject it, and both failure modes were reproduced on purpose.
- **`verify` and the pipeline are compared in both directions.** The old comparison proved every
  CI step was runnable locally and said nothing about the reverse, so
  `bun run config:example -- --check` ran locally and never in CI. A check that cannot block a
  merge is a suggestion.
- **Branch names are checked** rather than named in a document nothing reads — the rule had been
  broken twice already. The prefixes are the Conventional Commit types, so a branch and its commits
  use one vocabulary (`CONTRIBUTING.md` §8).
- **`OVERVIEW.md` no longer states progress.** It said Phase 0 had not started, in a repository
  with a database, a contract and a pipeline in it. `bun run queue` computes it.

### Specification — 2026-09-09 (fourth pass): the interface, the budgets, and the escape hatch

The previous pass made seven rules fail the build and left the hatch that makes all of them
optional wide open. This pass closes that, and settles the two things the enforcement layer could
not check because nobody had decided them: what the interface is made of, and what "fast" means as
a number a build can fail on.

- **D-48** — exceptions are **expensive and visible, not closed**. Nothing stopped
  `// eslint-disable-next-line @typescript-eslint/no-explicit-any`, which made every rule optional.
  Each exception now names its rule, explains itself and links an issue; an unused one fails the
  build, so the debt cleans itself up. An outright ban was rejected: it pushes people to loosen the
  shared config instead, and a rule quietly weakened for the whole repository is far worse than one
  line marked as an exception. **The target is zero exceptions nobody can count, not zero
  exceptions.**
- **D-49** — seven performance budgets were declared CI-enforceable and **none was measured**, which
  is the exact failure D-17 exists to prevent, reproduced inside the document containing D-17. The
  two deterministic ones now block; the five that move between identical runs block on a regression
  instead. Thresholding a noisy p95 teaches a team to say "flaky, re-run it", and that habit does
  not stay confined to one check.
- **D-50** — the client stays a single-page application with a **prerendered shell**. The incumbent
  everyone finds heavy is not heavy because of how it renders; it is heavy because of how much it
  ships and how much it holds, so the answer is D-49's two numbers rather than a different
  architecture.
- **D-51** — desktop and mobile are **the same client in a shell**, and the bar is polish rather
  than platform nativeness. Recorded because the quality bar named two exemplar groups that made
  opposite decisions: none of the interface exemplars ships a native desktop application. Native
  Swift clients are **not planned** — not deferred, since that choice changes the design system and
  the contract from the first component.
- **D-52** — the frontend gets an architecture rather than only an interaction spec: **one source
  for every visual value** with a literal as a lint error, headless primitives for the five
  components where focus and ARIA fail silently, `axe` and a keyboard-path test per screen, visual
  snapshots, and a justification owed for each new primitive. `@base-ui-components/react` was the
  obvious modern choice and is **deprecated at release-candidate stage** — checked rather than
  remembered.
- **D-53** — "production-ready" is a **per-screen definition of done**, not a phase. Phase order
  decides what ships; this decides what shipping means. Each cause of an unfinished feel gets a
  mechanism instead of an intention.

### Specification — 2026-09-09 (third pass): making the rules executable

Forty-four decisions and eleven invariants, and **not one of them enforced by anything but
reading**. That is the mechanism by which a well-specified project quietly becomes an ordinary
one: the documents stay true and the code stops matching them, one reasonable exception at a time.
This pass closes that, and it is the last one before code.

- **D-45** — the Kysely types are **generated** from the applied migrations, not hand-written.
  `SCHEMA.md` §10 previously admitted to a hand-maintained copy policed by a drift test, which is
  the exact trade the ownership rule tells us not to make — and weaker than it looks, since a
  drift test only catches what someone thought to compare. Generation makes drift impossible
  rather than detectable. D-20's rejection of an ORM does not apply: code generation is build-time.
- **D-46** — integration tests run in **one transaction per test, rolled back**, with a template
  database for the cases that cannot. The consequence is architectural and is why it could not
  wait: **every service takes its executor as an argument**, so a service reaching for a
  module-level database handle is now a lint failure. Also written down: a flaky test is
  quarantined the day it appears and fixed or deleted within one working day, because a suite
  people learn to re-run has stopped being a gate.
- **D-47** — **a rule that is not mechanically enforced is not a rule.** The first code written is
  the enforcement layer, and its acceptance is a demonstration: a pull request containing `any`
  must go red. `strict: true` becomes the floor rather than the ceiling
  (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`); lint rules become type-aware, which
  closes the likeliest defect in this architecture — a transaction whose `await` was forgotten;
  the layering rule becomes a real lint configuration; the documents' invariants become
  architecture fitness tests; `main` gets branch protection **that applies to the author of this
  entry, who pushed to it directly four times while writing these documents**; `AppError` codes
  become a discriminated union instead of free text; and request-id logging exists from the first
  handler rather than from the phase that needs it.

  Rejected in the same decision, so the effort goes where it pays: mutation testing, a global
  coverage target, DDD ceremony, pre-commit hooks as the authority, and tuning a build graph with
  nothing yet to build.

### Specification — 2026-09-09 (second pass): the product gained a cloud

The founding decision said *not a SaaS*. It now ships two ways, and that reopened everything
downstream of it. Three decisions were **rewritten** rather than amended, because patching a
decision whose premise changed leaves the old reasoning in place for the next reader to trust.

**Rewritten**
- **D-1** — self-hosted open source *and* a cloud we operate. Four audiences; the dogfood team
  still holds the only veto. **No open core**: the cloud runs the same code and sells operation,
  never withheld capability. The original decision's own warning — that paying customers would
  push roughly 40% of the engineering budget into non-product work — is now accepted rather than
  avoided, and phased so it cannot arrive before there is a product worth charging for. The size
  of the business is written down as a constraint: a small operation funded by its users, not a
  growth-stage SaaS.
- **D-24** — **MIT → AGPL-3.0, plus a CLA.** The original reasoning hinged word-for-word on
  *"D-1 explicitly gave up commercial ambition"*, which is no longer true. It also contained an
  error worth naming: it rejected AGPL because companies ban AGPL dependencies, which is a cost
  that applies to **libraries linked into a product**, not to an application a company runs
  internally. The CLA matters now rather than later — the ability to relicense or dual-licence
  ends at the first merged outside pull request, and `README.md` still says contributions open in
  Phase 2. `LICENSE` replaced; `NOTICE` added.
- **D-28** — for the cloud **we are the data processor**, so the DPA the previous decision
  refused to publish is now genuinely required, along with a real subprocessor list and breach
  notification. For self-hosters nothing changes: the operator is the controller and we are not a
  party at all. Two postures, stated separately, because one document covering both would be
  wrong in both directions.

**Amended** — D-7 (the shared broker is required by the cloud and *never* by a self-hoster),
D-20 (PostgreSQL 16 → **18**, versions pinned to current stable, ElysiaJS named as the highest-risk
choice now that uptime is a commitment, with Hono as a written fallback and a four-week trigger),
D-25 (multi-node is an obligation for one deployment and a measurement for the other), D-27
(retention is set by the operator when they own the disk, and by the plan when we do), D-31
(SSO has a paying demander now), D-10 (a vestigial line about text search configuration removed).

**Added**
- **D-39** browser and transport security. The gap that mattered: **no `Origin` validation on the
  WebSocket upgrade**, which is cross-site WebSocket hijacking, and it is built in Phase 0.
  Also: attachments served defensively, the one-line "external images proxied" turned into a
  hardened fetcher rather than an SSRF endpoint, a CSP baseline, and AES-256-GCM named for a key
  the configuration had already required.
- **D-40** deterministic collation. `lower('İ')` is not `i` under a Turkish locale, so channel-name
  uniqueness depended on how the server was provisioned. Identifier columns now declare
  `COLLATE "C"`, `citext` is dropped for the same reason, and `/health/ready` asserts it.
- **D-41** English and Turkish from the first screen, built on `Intl` and typed catalogues with no
  i18n library — a missing key is a compile error, and the 250 KB budget survives.
- **D-42** the cloud stays shared-database multi-tenant. The accepted cost is the largest in the
  document: an isolation bug reaches every customer at once, which is exactly why D-21 and D-34
  are enforced by types rather than by review.
- **D-43** per-**workspace** pricing, never per seat — charging by seat would contradict the cost
  axis the product competes on and the first paragraph of the README. Sold through a merchant of
  record, with a numeric trigger for moving to direct payments.
- **D-44** backups with a *tested* restore, error tracking, uptime monitoring, a status page, and
  `pino` named at last for the structured logging §10 had always mandated. No telemetry is ever
  collected from a self-hosted deployment.

**Scope** — a new phase, **2.5 / `v0.4.0` — Cloud**, gated on S-3 and blocked until S-1 is met.
`PRD.md` gains a fourth success criterion and a second primary persona; §6 keeps *per-seat
billing* on the permanent non-goal list and adds *open core* to it, while billing itself leaves.

### Specification — 2026-09-09

A capacity, compliance and operations pass. Four questions that the specification had never been
asked were answered, and answering them exposed one internal contradiction that had to be fixed
rather than worked around.

**Added — `DECISIONS.md` D-25 – D-32**
- **D-25** capacity: a numeric build target (300 sockets, 20 msg/s) and a multi-node ceiling
  (1 000+), with the three triggers that open Phase 3. D-7's rule finally has a measurement to
  point at. Two new seams follow — `PresenceRegistry` and `RateLimiter` — because they are the
  only node-local state whose *correctness* changes on a second node.
- **D-26** an append-only `audit_log` for administrative actions. Never message content.
- **D-27** retention, erasure and export — **closes O-3**. Retention is opt-in per workspace and
  defaults to infinite, so the "nothing is thrown away" tenet is unchanged. Account erasure and
  content erasure are two deliberately separate operations.
- **D-28** the project is not a data processor and will not publish a DPA. Ships the operator's
  data map and runbooks instead.
- **D-29** notifications now include **thread participation** — revises D-12. Without it, the
  person who asked the question never learns it was answered, which is the product's own thesis.
- **D-30** background work is CLI commands under an external scheduler; `job_runs` exists so a
  cron nobody installed is visible rather than silent.
- **D-31** SSO leaves the permanent non-goal list for Phase 3 (OIDC, gated on demand). SAML
  stays permanently refused.
- **D-32** work is tracked in GitHub Issues and Projects. Linear rejected: per-seat closed SaaS,
  which is the model D-1 exists to reject.

**Fixed — a contradiction, not a wording change**
- `PRD.md` §6 and D-1 both listed SSO/SAML as permanent while D-25 and D-26 described an
  organisation that has an identity provider. A non-goal contradicted by another decision teaches
  readers the whole list is negotiable, so it was resolved rather than softened.
- `SCHEMA.md` shipped `notification_type` values `thread_reply` and `thread_resolved` that D-12
  forbade. Resolved in favour of the enum, by D-29.

**Added — `DECISIONS.md` D-33 – D-36, closing the gaps a pre-implementation review found**
- **D-33** the client-supplied `messages.id` is validated at the boundary — v7 shape and a
  timestamp within `[now − 60s, now + 5s]` — and `ON CONFLICT` no longer returns an ACK without
  verifying the existing row belongs to the same sender and channel. D-8 made the id
  client-generated and never said what happens when the client sends something else; a poisoned
  id is a primary key and cannot be repaired. Clock skew is corrected from `ServerFrame.ts`,
  a field that was already defined for it and never used.
- **D-34** channel visibility becomes a second branded context. `WorkspaceContext` made the
  tenant axis structural; the channel axis was left to call sites, and two specified endpoints
  leaked because of it — search, and the open-questions view, which as written listed every
  member's private discussions. A third mandatory test class follows.
- **D-35** the message write path is one transaction, and the `EventBus` publish happens **after**
  the commit. Publishing first lets a subscriber receive a message that then rolls back, and with
  a durable client-generated id that client cannot learn to forget it.
- **D-36** markdown stays the only stored representation and §8.1's rationale is corrected: it
  claimed to save client render cost, which it never did. The content-pipeline dependencies §8
  was built on are now named in `ARCHITECTURE.md` §2 with their costs.

**Added — `DECISIONS.md` D-37, D-38, closing the last two gaps that blocked Phase 0**
- **D-37** `WORKSPACE_OPEN_JOIN_SLUG`. Phase 0's exit criterion requires two GitHub users in one
  workspace, and no Phase 0 endpoint could put them there — invitations are Phase 1 and joining a
  channel already requires membership. The phase had been defined with an exit criterion its own
  scope could not reach.
- **D-38** GitHub identity, with every collision given a defined answer: the requested scopes
  (`read:user user:email`) were written down for the first time; the email is the primary
  **verified** address or sign-in is refused, because the default `/user` response omits it for
  any developer who has not made it public and `users.email` is `NOT NULL`; a known address
  arriving under a different `github_id` is refused rather than silently linked (D-5); a username
  freed by a GitHub rename and taken by somebody else no longer collides fatally. It also closes
  an interaction neither D-22 nor D-27 covered — erasure now clears `github_id`, so signing in
  again creates a new account instead of resurrecting the one the person asked to have removed.
  Invariant I-11 extended.

**Fixed — found by a machine audit of every cross-document reference**
- `UX.md` §5 pointed at `PRD.md` §4.2 (*Threads*) for a statement about GFM in the composer,
  which belongs to §4.1 (*Messaging*). The section number was valid, so no link check would ever
  have caught it — only resolving each reference to its target's **title** did.
- `PRD.md` §4 carried a `4.6b` subsection. Renumbered to 4.7 and 4.8; nothing referenced §4.7,
  so the renumbering was free.

**Repository — work tracking moved to GitHub**
- **`docs/ROADMAP.md` retired.** Its task list now lives as GitHub Issues, one per task, and
  keeping both would have been exactly the duplication `OVERVIEW.md`'s ownership rule forbids.
  Its two unique facts moved rather than vanished: the working rule went to `CONTRIBUTING.md` §7,
  and the "never" list was already only a pointer to `PRD.md` §6. Eleven references updated in
  the same change.
- Milestones are versions, not phase names: `v0.1.0`, `v0.2.0`, `v0.3.0`, `v1.0.0`. The phase each
  one corresponds to, and its exit criterion, live in the milestone description; `PRD.md` §4
  remains the owner of what a phase contains.
- Issue templates for epic, feature, task and bug, plus a pull request template, each carrying the
  definition of done in two tiers — what always applies, and what applies conditionally. A
  checklist whose items do not all apply is a checklist people learn to tick without reading,
  which is the same failure D-17 was written to prevent.

**Repository**
- The contributor rules moved from an agent-specific filename to **`CONTRIBUTING.md`**, which is
  what an open-source repository is read for anyway. Content and section numbering are unchanged,
  so every `§` reference in the other documents still resolves. Agent entry points, vendored
  skills and their manifest are untracked.
- Five `.gitignore` patterns carried inline comments. Git does not support them: the trailing
  text became part of the pattern, so the agent-tooling directory was never ignored and
  `!.env.example` never took effect — which would have silently prevented Phase 0 from committing the file `CONFIG.md`
  requires.

**Schema**
- `workspaces.retention_days` (NULL = infinite, floor of 30 days), `audit_log`, `job_runs`
- New `SCHEMA.md` §9; Kysely types, invariants I-9 – I-11, migration `0009_administration.sql`.
  The unapplied Phase 2 migrations shifted to `0010`/`0011` — legal only because neither had run.
- Sections renumbered (Kysely §10, Invariants §11, Migrations §12) and every cross-reference in
  `ARCHITECTURE.md`, `CONTRIBUTING.md`, `UX.md` and `ROADMAP.md` updated in the same change.

---

### Specification — 2026-09-07

The four original drafts were solution specifications with no problem specification behind
them, and they contradicted each other in ways that would have failed at the first `INSERT`.
Reviewed, decided, and rewritten.

**Added**
- `DECISIONS.md` — 23 decisions, each with its rejected alternatives and reversal cost
- `ROADMAP.md` — phase-by-phase execution plan with exit criteria
- `PRD.md` now has a persona, a problem statement, success criteria and a competitor position
- Schema: `sessions`, `attachments`, `mentions`, `notifications`, `link_previews` — all five
  were promised by the PRD and absent from the schema
- `ARCHITECTURE.md`: `EventBus` seam, `WorkspaceContext` branded type, reconnect/replay
  protocol, error and observability rules

**Changed**
- `messages.id` → application-generated **UUIDv7**; pagination is keyset on `id` alone (D-8)
- Message ordering no longer depends on `created_at`, which was unstable within a millisecond
- Direct messages are workspace-scoped; cross-workspace DM removed (D-6)
- `parent_id` → `ON DELETE RESTRICT`, so soft deletion no longer destroys threads (D-9)
- Channel name uniqueness → partial index over named channels only; DMs keyed by `dm_key` (D-6)
- Workspace ownership → `workspace_members.role`; `owner_id` removed (D-22)
- `users.github_id` → nullable (D-11)
- `message_type` → `{text, system_event}`; a code block is not a row type
- Text search config → `simple`; the English `tsvector` column and index dropped (D-10)
- Unfurl cache → PostgreSQL `link_previews`, with negative caching (D-23)
- Performance targets → seven measurable budgets (D-17)
- Web Worker usage → measurement-driven, no longer a blanket rule

**Added in the audit pass** — five documents the specification referenced but did not have:
`README.md` (named directly by success criterion S-2), `docs/UX.md` (the wedge is a behaviour and
had three sentences), `docs/API.md` (the HTTP contract existed only as scattered mentions),
`docs/CONFIG.md` (the config loader was required to validate variables nobody had listed), and
`LICENSE` — the project called itself open source in three places while granting no rights at
all (D-24, MIT).

**Documentation hygiene** — after an audit pass, six facts that had been stated in two or three
files each were given a single owner, with the other locations reduced to pointers:
phase contents and non-goals → `PRD.md` · performance budgets → `PRD.md` §5 ·
stack and accepted costs → `ARCHITECTURE.md` §2 · required tests → `ARCHITECTURE.md` §10 ·
open questions → `DECISIONS.md` Part D · attachment size limit → the `attachment_size_limit`
constraint. An ownership table now lives in `OVERVIEW.md`.

Also fixed: `ARCHITECTURE.md` stated a WebSocket rate limit as settled while `O-4` recorded it
as an open question — it is now marked provisional in both places.

**Removed**
- Redis from Phases 0–2 — a single node needs no broker (D-7)
- Tauri from Phase 1 — moved to Phase 3 (D-14)
- Magic-link auth and GitHub webhook feeds from the MVP — moved to Phase 2 (D-5)
- Personal scratchpad — a self-DM does the same job with no new schema (D-5)
- The `<35MB idle memory` requirement — unachievable as stated (D-14)
- The "sub-millisecond search" claim — unachievable and unmeasurable as stated (D-10)
- The "local-first" claim — Zustand is in-memory; the accurate word is *optimistic* (D-19)
