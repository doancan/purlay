# D-231. Three gaps an audit found: a replayed delivery, a sign-in lockout, a year-long cached file — amends D-109, D-134, D-138

**Decided (the owner, 2026-10-31).** Three low-severity findings, each closed where it was, none by a new
moving part.

1. **A delivery is posted once by its body as well as by its id** (amends D-134 §5). `X-GitHub-Delivery` is
   not signed — the HMAC covers the body alone — so anybody who saw one signed delivery could send its body and
   signature again under an id made up, and the channel got the event twice. D-134 §5 had accepted that; it is
   closed now because closing it costs one column. `github_deliveries.body_digest` is the SHA-256 of the body as
   sent, written in the transaction that posts it, unique per feed (migration 0064, `SCHEMA.md` §8.3); the insert
   does nothing on either key, so the same id again and the same body under another id are both `duplicate`, and
   two at once wait on each other's row as D-134 §5's id already did. Per feed, since the secret is: the same
   bytes to another feed are that feed's. Remembered as long as the ids are — `GITHUB_DELIVERIES_KEPT_DAYS`, by
   the same sweep — so a replay older than that posts again, as a redelivery that old would; GitHub redelivers
   only three days back. Two genuine deliveries with byte-identical bodies are not a case GitHub makes: every
   event carries what changed (a push's `after`, an issue's `updated_at`), and a redelivery has its first id.
   The digest, never the body: a copy of the database holds no event that was not posted.
2. **The sign-in link limit is per address *and client*, under a per-address ceiling** (amends D-138 §7). Five
   links an hour per address, whoever asked, let anybody send six requests for somebody's address each hour and
   keep them out of signing in by email. Now: twenty requests an hour from a client, as before; **five links an
   hour for an address from one client** — a stranger spends their own five, never the owner's, as a wrong
   password does (D-179 §4, `password-attempts.ts`), a client being its network (`limitKeyFor`); and **twenty
   for an address from every client**, so a mailbox is still not flooded. The ceiling is counted only past the
   client's five, so one client spends at most five of it. Still `202` whatever is decided, and nothing in the
   answer or its time says which limit held (D-138 §1). The counters are `rate_limits` rows under the address's
   digest — `…:address:<digest>` and `…:address:<digest>:client:<digest>` (`SCHEMA.md` §3.2) — and an erasure
   deletes them all by that prefix. Residual, accepted: someone with four networks can still spend an address's
   ceiling for the hour; that is a bar raised from one client to several, and the price of bounding a mailbox at
   all. Provisional with the rest of O-4.
3. **An attachment is the browser's to keep and the server's to allow, every time** (amends D-109 §6). A year's
   `immutable` let a member removed from a channel — or from the workspace — open every file of it their browser
   had kept. Downloads and thumbnails are now `Cache-Control: private, no-cache` with a tag (`"<id>-<variant>"`):
   the browser keeps the copy and asks before using it; the server checks the session and the reader's access as
   for any download, and only then answers `304` with nothing read from the store, or `404`. The bytes behind an id
   never change, so the tag needs nothing stored. The cost is a round trip per use of a kept copy — one session
   lookup and the one guarding query, no bytes — where there was none. **The image proxy keeps its day** (`private, max-age=86400`): its bytes are an
   image public where it lives, there is no access to withdraw from it, and asking again would mean fetching it
   from its server again through four slots a node.

**Considered and rejected.** *Signing the delivery id ourselves*, or *GitHub's timestamp*: GitHub signs neither,
and only the body is the sender's word. *Keeping deliveries' bodies*: the digest decides the same thing and holds
nothing. *A per-address limit with a challenge (CAPTCHA) past it*: a new dependency and a page D-138 does not have.
*A higher per-address limit alone*: it trades a lockout for a flood and fixes neither. *A short `max-age` on
attachments*: a window in which a removed member still opens the file — shorter, still there — for a saving the
`304` already makes. *`no-store`*: every view would download the bytes again, a cost the tag avoids. *The same
policy on the image proxy*: above.

**Cost of reversing.** §1: migration 0064 dropped in a new one and the insert's conflict narrowed back to the id.
§2: the client's key dropped from the address's count. §3: the header and the `304` branch in
`ingress/http/attachments.ts`. Each has its tests and mutations.
