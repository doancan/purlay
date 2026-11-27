# D-201. The cloud's nodes share one Redis for the bus, the limiters and presence, chosen by `REDIS_URL` alone — builds on D-7, D-25, D-82, D-84, D-190, D-198

**Context.** D-7 (amended) made the shared adapter a requirement of the cloud, and D-25 placed three seams for it so that
it would be a file and not a refactor: `EventBus`, `PresenceRegistry`, `RateLimiter`. A second node makes each wrong in a
different way — a frame published on one node never reaches the sockets of the other; a person online on one is offline
to the other; the quota is granted once per node. The self-hosted product is unchanged and stays broker-free (D-7).

**Decided.**

1. **`REDIS_URL` is the only switch.** Set, `index.ts` opens the link (`platform/redis.ts`) and builds the shared adapters
   (`realtime/shared.ts`); unset, nothing here is built, no client is constructed, no timer starts, and the in-process
   implementations run exactly as before. `shared.test.ts` holds that: it makes every Redis client constructor throw and
   builds the application and its sockets, and it reads the source for the only two places that may name a client or ask for
   a link. The address is an environment variable only (`CONFIG.md`), a secret like `SMTP_URL`, never logged; the
   self-hosted compose file withholds it with a reason.
2. **Bun's own client, no dependency** (`CONTRIBUTING.md` §1.12). It has commands, scripts and pub/sub. It was measured
   not to subscribe again after its connection came back (a publish after a Redis restart reached nobody) and to give up
   after twenty tries, so the link owns reconnection: a lost connection is replaced by a *new* client after a wait that
   doubles from 250 ms to 15 s with jitter, for ever (starting over only once a connection has held for ten seconds, so
   a Redis that accepts and drops is backed off from), and every channel is subscribed again on it. A command never waits
   for a connection (offline it fails at once, connected it fails after two seconds and ends that connection), a
   connection that goes silent without closing is found by a ping every five seconds, and nothing is left unhandled.
3. **The bus is one Redis channel for the cluster, filtered in the node.** A publisher never fans out itself: it publishes
   and hears its own frame back, as every node does, so a frame is delivered once on each node, in the order Redis took
   it, and a channel's frames are in one order everywhere. The replay and changes-feed logic (D-82, D-190, D-194) is not
   touched. **While Redis is away** a node delivers to its own sockets (the people on it still hear each other); with only
   the subscription down, it also publishes for the others and delivers directly, since its echo will not come. **When the
   subscription is made again, frames were missed**, so the node closes its sockets with `RESTARTING` and they replay from
   their cursors: what a deploy does (D-72), by the code that already exists. **A frame that never reached Redis** from a
   node whose own connection was away leaves the other nodes' subscriptions up and nothing to tell them: each frame
   carries its publisher's name and a count, and a node that hears a hole in a count treats it as a gap, the same way.
4. **The limiters that are keyed beyond one connection are shared; the per-connection one is not.** A token bucket in one
   Lua script on Redis's clock — read, refill, spend and write in one step, so two nodes cannot both spend the same
   tokens — named per budget (a user's writes and a user's costly reads never share a bucket) and expiring by itself when
   it would have refilled. The user's write bucket (D-81, D-198's ten a second, burst sixty, charged by HTTP and the
   socket alike), sign-in and setup by address, the webhook and GitHub-call buckets are shared. The **socket's frame
   budget stays in process**: a socket lives on one node, so no node can grant it twice, and a Redis round trip per frame
   would sit on the hottest path for nothing.
5. **A Redis that does not answer: the limiter uses a bucket of its own node's.** Not closed (every write and every
   sign-in refused: the product is down because a cache blinked) and not open (no limit while the shared state is away).
   For as long as Redis is away the quota is the in-process one, N times on N nodes, which is what the product always
   had; the line says so at `warn` while connected and at `debug` while the link has already said it is down.
6. **Typing is one key per person and channel**, the in-memory rule on Redis's clock (tell the room when there is no window
   or it is half spent); unreachable, this node's own window answers — a frame too many per node, never a wrong answer (D-25).
7. **Who is online is a claim per node.** A hash per person holds each node's claim with the time it lapses and the version of
   the last change; a node renews its claims every ten seconds and they lapse in thirty, so **a node that dies leaves nobody
   online for longer than that**: read as offline by every snapshot, and **told by whichever node finds them first** — an
   index of when each person's last claim lapses is swept at every renewal, and the version is given once. A node that
   stops gives its claims up, so a deploy is told within a renewal; a person held elsewhere is not. A join or leave is given a version only when it changes whether the person is online *anywhere*:
   the first socket on a second node, and the last on one of two, tell nobody. Versions come from Redis's clock and only
   grow, so two nodes with clocks apart still agree which change is later, and a snapshot's version is smaller than every
   change after it. Calls for one person are made in order on a node. Unreachable: a person is online here whatever the
   record says (told, at a version larger than any the record gave), a leave is not told (the claim lapses and is swept),
   and a read is answered from the node's own sockets.
8. **Readiness.** A node that has **never** reached Redis since it started is not ready (a wrong address is found by the
   deploy, not by a user); a node that has, and loses it, stays ready and says so in its log. Every node refusing traffic
   because the shared piece blinked would be the outage; `/health/ready` still says a word and the log the reason.
9. **Tests.** Unit, against a fake link (what is asked, what is done on a failure); and against a real Redis, behind the
   existing integration conventions (`*.redis.integration.test.ts`, refusing without `REDIS_URL`, left out of `test:all`
   behind a banner where there is none, required in CI): one quota under two hundred concurrent calls across two nodes, a
   dead node's claim lapsing, one order across three nodes publishing at once, a link whose connection is cut and made
   again, and two whole applications — hubs, sockets, database — sharing one Redis (a message, a sign-out, presence, typing,
   the write quota, a node that loses Redis and sends its sockets back to replay). `docker-compose.yml` has a `redis`
   service for it, started by `bun run db:up:redis` and, in CI, beside the database; `bun run db:up` does not start it.

**Rejected.**
- *A Redis channel per topic.* The hub subscribes and then replays from the database (D-82); the bus interface's `subscribe`
  is synchronous, so a frame published between the call and Redis's acknowledgement would be lost for good. Every node
  hearing every frame is a few kilobytes a second at D-25's ceiling and has no such window. Reverses if that traffic is
  measured to matter: then an acknowledged subscribe, awaited before the replay, is the change.
- *Redis Streams.* Order and replay are already the database's (D-190); a stream would be a second log to trim and read.
- *`LISTEN`/`NOTIFY` on PostgreSQL.* It would make the bus depend on the connection pool's headroom and cap a payload at
  8,000 bytes; Redis is wanted for the limiter and presence in any case.
- *A client library* (`ioredis`, `redis`). Bun's covers what is used; the one gap found is the reconnection, which is the
  link's.
- *Failing the limiter closed or open* (5), *failing readiness on any loss of Redis* (8), *sharing the per-socket frame
  budget* (4), *a presence record without lapse* (a dead node would hold people online for ever).

**Accepted.**
- Each node hears every frame published anywhere and drops those it has no socket for.
- A publish that times out *after* Redis took it is delivered twice to the node that fell back to direct delivery, and
  after later frames; a frame is idempotent on its id and version, a client keeps the larger, and the sockets replay.
- A dead node's people read as online, and are told so, for up to thirty seconds and one renewal after it died. While Redis is away the quota is N times; presence is each
  node's own, and the sockets of a node that missed frames replay on its return — a reconnection storm the size of a deploy.
- The scripts are sent whole with each call (`EVAL`, not `EVALSHA`): a few hundred bytes a call, no `NOSCRIPT` to handle.
- One Redis with one primary. Redis Cluster is not supported: the presence read is one script over many keys.
- Sticky load balancing is not configured here; it is documented in `ARCHITECTURE.md` §11 and remains #115's.

**Reverses if** the cloud's measured bus traffic makes every node hearing every frame a cost (per-topic channels with an
acknowledged subscribe), or a loss of Redis is found to leave sockets silent that this entry says are not.
