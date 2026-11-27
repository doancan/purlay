# D-134. A repository's feed: GitHub's events as messages with no author — #79

**Context.** D-5 put webhook repo feeds in Phase 2 — "signature verification, delivery dedup, retry and
replay" — and `SCHEMA.md` §8.3 settled a table for them. Nothing said who a feed's messages are by,
where its secret lives, who sets one up, or what a duplicate, a flood or a lost channel does.

**Decision.**
1. **A feed connects one repository to one channel**, for `push`, `pull_request`, `issues` and
   `release`; one channel may have feeds from several repositories and one repository may feed several
   channels, never one channel twice (`UNIQUE (channel_id, repository_full_name)`, the name kept in
   lower case as GitHub compares it). Not CI, check or deploy events — D-110 and D-118 left those
   rows out, and this does not bring them back — and not an Integrations section: a feed is set up
   from its channel. What each posts: a push to a branch or a tag; a pull request opened (not as a
   draft — its being ready for review is the announcement), closed, merged, reopened; an issue opened,
   closed, reopened — not deleted or moved, which leave the earlier message pointing at GitHub's own
   answer; a release released or pre-released, said as which, once — GitHub's `published` beside
   them is not posted, and a pre-release promoted is. Every other action is received and not posted.
2. **Set up and removed by an owner or an admin** (§7.4's "configure GitHub integration"), from a
   channel they can see — a role is not a way round visibility (D-123 §2): a channel they cannot see
   has no feeds for them, and its feed is `404`. Each is one row of the audit trail
   (`integration.feed_created`, `integration.feed_removed`) with the repository's name — accepted: an
   admin reading the trail learns that a repository was connected somewhere, not where, as an
   archived private channel's name is on it already (D-123). A direct message has none.
3. **Each feed has its own secret**: 32 random bytes the server makes, sealed by the one cipher
   (D-39 §6) with the feed's id bound in, answered once with the payload address — the screen that
   shows them says the content type GitHub must send, `application/json` — and never again. A lost
   secret is regenerated: *amended 2026-11-01 (#884), where it was a feed removed and made again.*
   `POST /api/channels/:channelId/github-feeds/:feedId/secret`, by an owner or an admin, makes a new
   secret for the same feed — same id, same address — and answers it once as a feed's creation does; the
   old one stops verifying at once, since the secret is read per delivery, and the deliveries GitHub sends
   with it are refused (`401`, and a `warn` line) until the webhook there has the new one, which the
   screen says before it asks. The trail records `integration.feed_secret_regenerated` with the repository
   and the channel, never a secret. The address carries the feed, `/api/webhooks/github/:feedId`: a secret per feed must be
   found before the signature is checked, and a repository's name, unverified, names a feed in every
   workspace that has one.
4. **A delivery is checked before it is read**: a feed that is not there is `404`; a body without a
   length, or longer than `WEBHOOK_BODY_MAX_BYTES` (1 MiB), is refused before it is read; the
   `X-Hub-Signature-256` HMAC over the bytes as sent, compared in constant time, is the only
   credential — wrong, missing or malformed is `401`. Each client address has a bucket before anything
   is looked up, a node reads a few bodies at once, each within a deadline, and each feed has its own
   bucket after the signature — so nobody who knows an address can spend a feed's, or hold every read
   open; all provisional (O-4). A delivery from another repository than the feed's is refused: by its
   number once a delivery has named it, by its name until then; a renamed repository keeps its feed,
   and its new name unless another feed of the channel holds it.
5. **Each delivery is posted once.** Its `X-GitHub-Delivery` id is recorded in the transaction that
   posts it; the same id again is `200` and posts nothing. GitHub does not retry on its own: *retry and
   replay* (D-5) are an admin's Redeliver in GitHub, made safe by this, and a delivery that failed
   answers `5xx` so GitHub shows it failed. GitHub redelivers only what it received in the last three
   days; the ids are kept thirty, a margin rather than a mirror, by a daily job (`sweep:github-deliveries`,
   D-30). A delivery that failed and was not redelivered in those days is lost — said on the feed (§8).
   Accepted: the two headers are not signed, so a signed body sent again with a new id posts again —
   TLS is what stands between them. *Amended 2026-10-31 by D-231 §1:* no longer accepted — the body's
   digest is recorded beside the id, and a body a feed has posted is a duplicate under any id.
6. **A feed's message has no author.** Its `sender` is null — `message_type = 'system_event'`, held by
   a `CHECK` that a person's message has a sender and an event has none — and it carries the event
   (`githubEvent`) as parts: repository, actor's login, and what happened, every field bounded, each
   link built from its parts as `GitHubLink`'s are (D-101), never taken from the payload. Nobody can
   edit one; an admin may remove it, as any message (D-34). It is no thread's author, so a reply or a
   resolution under it tells nobody for it; its text, an English summary, is what search finds —
   accepted: a reader searching in Turkish finds an event by its repository, its title or a login,
   not by the sentence drawn in their language. Its kind is held by the table
   (`messages_event_known`) and its shape by its one writer; a row the reader still cannot say is
   refused loudly rather than drawn as somebody's message or as nothing, so `GitHubEvent` changes
   only by adding.
7. **Quiet**: an event counts as unread like any message and never notifies, at any level and by no
   push — an amendment of D-107's `all`, which is about what people write. Nothing in it is parsed
   for `@`: a pull request titled `@alice` names nobody (D-12).
8. **A feed that cannot post says so** where it was set up: the last delivery and the last failure,
   with its reason — the channel archived, another repository, a body that is not the event, one too
   many for its bucket (0033) — are on the feed, and every delivery is one log line — feed, delivery,
   event, outcome, never the body. An archived channel's feeds, and a deleted workspace's, refuse
   their deliveries. A refusal before the signature is said in the log alone: anybody can cause one.
   *Amended 2026-11-01 (#884):* a signature that does not hold is one `warn` line too — `github delivery`
   with the feed and `outcome: bad_signature`, never the secret, the signature or the body — since a
   secret pasted wrong at GitHub, or one regenerated and not yet updated there, is otherwise silent; it is
   still not said on the feed, where anybody's could bury a real failure, and it is bounded by the
   address bucket.

**Rejected.** *The creator as the author* — every place that asks "is this mine?" would answer yes
for an admin's every push: their bubble side, their edit shortcut, their unread count, a thread's
replies notifying them. *A GitHub user row* — a `users` row needs an email and a username that a real
GitHub account may hold, and it would be a member, a mention and a search result. *One webhook per
workspace, routed by repository name* — the name is not verified until the secret is known, and a
repository is in more than one workspace. *Our own retry queue* — GitHub keeps each delivery three
days and redelivers it on request; a queue of our own would be infrastructure no measurement has asked
for (CONTRIBUTING §1.11).

**Cost of reversing:** migrations 0031, 0032 and 0033, the event union on `Message`, three channel routes,
the webhook route and its job.
