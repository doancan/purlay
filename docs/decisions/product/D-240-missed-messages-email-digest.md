# D-240. Email about what a person missed: opt-in, one letter an hour, after fifteen minutes unread — builds on D-12, D-15, D-126, D-148, D-234; closes #868

*Amended by D-302: durable claims recover after a worker restart and retain earlier stop links.*

*Amended by D-297: Delivery is at least once and not never twice; a repeat carries the same `Message-ID`, and an address refused for good is not tried again.*

**Decided (the owner gave the decision to the maintainer, 2026-11-01).** A person whose tab is closed and whose
device has no Web Push (D-126) — a desktop browser never subscribed, a phone that did not install the app (D-230) — is
told nothing of a direct message until they open Purlay again. Email is the one channel every account already has.

- **Off until the person turns it on.** "Email me about direct messages and mentions I haven't read", on
  Notifications. Quiet is the product (D-12): a server never mails anybody who did not ask. Offered only where the
  server has a mail relay and the person's address was verified; otherwise the card is not drawn and turning it on
  is `400` on `on`. Off is never refused. Per person, as quiet hours are (D-234).
- **From the moment it is turned on** (`users.missed_mail_since`): nothing told before is ever mailed, so turning it
  on does not send a year of old mentions. On again while on keeps the first instant.
- **A mention or a direct message** (`MISSED_MAIL_TYPES`), still unread, never mailed before. A thread reply and a
  channel set to every message stay with the inbox and push: the setting says direct messages and mentions, and a
  letter is a heavier interruption than a notice.
- **Fifteen minutes unread** (`MISSED_MAIL_DELAY_MS`): long enough that somebody at their desk, or reached by a push,
  has read it — a mail about what they read a minute ago is noise — and short enough that a direct message is not
  the next morning's news. The job runs every quarter hour (a new `quarter-hour` slot in the plan, at :07, :22,
  :37 and :52, clear of every other slot), so a letter leaves fifteen to thirty minutes after the message.
- **One letter, at most one an hour** (`MISSED_MAIL_WINDOW_MS`): what waits in between goes in the next. The letter
  counts each conversation's messages per workspace and quotes the newest three — who wrote and a plain excerpt of
  140 characters — each with its own address in the app (D-149), then the app, why it came and the stop link. In
  the person's language (D-41). Names and excerpts are other people's words: no line break, control or direction
  character, no `://`, cut short; the subject is fixed text. A push carries who and never what (D-126 §2) because a
  lock screen is not private; a letter goes to the person's own mailbox, which they asked for by name, and quotes
  only what they can read — the issue's own terms.
- **Quiet is kept.** A workspace where the person is in Deep Work, or every workspace in their quiet hours
  (`inDeepWork`, D-15, D-234), is held: nothing of it is mailed now, and what is still unread when it ends is mailed
  then — nothing lost, nothing interrupting.
- **Only what they can still read, decided when the letter is written.** A workspace they are in, a channel the one
  visibility rule shows them (D-34), a message not deleted. Anything else is passed over for good — marked, never
  quoted — so it cannot hold a place in the next batch. An erased, suspended (D-233) or unverified account is never
  mailed.
- **Never twice** (`notifications.mailed_at`). Each person is taken in a transaction of their own under their row's
  lock with `SKIP LOCKED`, so a second run passes them over; the hour and `mailed_at IS NULL` are read under it and
  the rows are marked, memberships first as a read takes them, before the commit. The letter is sent after the
  commit. If the relay refuses it, its rows are given back and its letter row deleted, and the run fails so
  `jobs:status` says so; a process that dies between the commit and the send loses that letter rather than sending
  it twice.
- **The stop link needs no session.** `/mail/stop#<token>`: a random token of `platform/tokens.ts`, its digest alone
  kept with the letter (`missed_mail_letters`), good for thirty days; the job deletes letters past that. Whoever opens
  it turns off the letters of the person it was sent to, and nobody else's; the page asks before it does, so a mail
  scanner that opens it stops nothing. `POST /api/missed-mail/stop` is charged to the client's address as sign-in
  traffic. One refusal, `404 MAIL_LINK_NOT_FOUND`, for a token nobody was sent and one too old.
- **Without a relay** the job takes nothing and succeeds: a relay added later mails what is still unread then. The job
  reads the relay from the server's settings on each run (D-179 §6), as the API does.
- **Erasure** clears the setting and deletes the letters (D-139 §5); the export leaves both out.

**Considered and rejected.** On by default (every person mailed by a server they never asked — the opposite of
D-12). A letter per message (the inbox's storm in a mailbox; the hour coalesces). A daily digest (a direct message a
day late is not what the person who asked wants; once an hour already caps it). Mailing thread replies and
every-message channels (the setting would say one thing and do another). A signed token instead of a stored digest
(a second scheme beside the one every bearer secret uses, and nothing to sweep). A `List-Unsubscribe` header with a
one-click `POST` (the relay is the operator's own and the volume is small; the link in the body is honoured by every
client, and a header can follow without a new contract). Sending inside the transaction (a relay's twenty seconds
under the person's lock, and a commit that fails after the send would mail it twice). Treating it as a non-goal's
"reminder" (PRD §6): a reminder is something a person schedules for later; this is the same notification the inbox
and push carry, by the one channel that reaches them when those two did not.

**Cost of reversing.** Remove the card, the page, the three routes and the job's slot; drop
`users.missed_mail_since`, `notifications.mailed_at` and `missed_mail_letters` in a new migration. Nobody is mailed
again; nothing else reads them.
