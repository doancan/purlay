# D-126. Web Push: who is told, what they are told, and where it may be sent — #78

*Amended by D-299: temporary provider failures retain a live subscription and its recorded streak is bounded.*

Phase 1 is silent with the tab closed (D-12, `PRD.md` §4.5). Web Push closes that, and every choice
below is about not undoing what D-12 made quiet, and not turning the server into something other
people can aim.

**Decided.**

1. **Who is pushed: the people a write told for the first time.** The notification rows a send
   inserts — none on a retried send, which writes nothing new; only the newly named on an edit
   (D-103) — of a reason in `NEEDS_YOU`, not `suppressed_by_deep_work` (D-108), not already read,
   for a message not deleted, to a person not deleted. `channel_message` included: a member who
   chose "every message" (D-107) asked to be told. Never the author.
   **Amended 2026-11-09:** each device is checked again immediately before its external request. Chat's
   `PushNotices.canDeliver` uses the shared message visibility guard and current unread, suppression,
   hidden-message and channel notification settings; the composition checks its current module grant.
   The sender also rechecks the session, recipient, workspace attention, Deep Work and quiet hours.
   A push still queued when private-channel access is withdrawn, the message is read or hidden, or the
   person mutes the channel no longer goes. A suppressed chat push remains available in the inbox.
2. **Who and where, never what.** The title is the place: `#api`, the person in a direct message, or
   a group's other people (D-127); the body is the inbox's own words for the reason, naming who did
   it (`alice mentioned you`, and in a group `alice wrote to the conversation`). The push service relays
   the payload encrypted for the device (RFC 8291), but a lock screen is not private.
   A notice of a reply opens its thread root, including mentions and reminders within a reply;
   ordinary top-level notices open the channel. Chat derives `PushNotices.threadId` from the existing
   parent/root and the sender carries it in the same `thread` query the in-app notification uses.
   The public push payload and the worker's site-path validation are unchanged.
3. **In the person's language (D-41 kept):** `users.locale`, set by the client when the person
   subscribes and whenever they change language (`PUT /api/me/locale`).
4. **A device belongs to a session.** A subscription carries the session it was made in: signing out
   deletes it, in the same transaction, and a subscription is written only while its session is
   live — a shared computer stops showing the last person's notices. An endpoint is unique across
   people: a browser signed into another account sends the same endpoint and the same keys, and
   moves to it; the endpoint alone does not move it, so knowing somebody's address cannot silence
   their device. At most twenty devices a person, the least recently subscribed dropped. The two
   VAPID keys are checked to be one pair before the server starts.
5. **Always shown.** Browsers penalise a push that shows nothing (Chrome's generic notice, Safari's
   revocation), so the worker always shows one, folded by channel. *Amended by D-143:* a push is
   held, on the server, while its person is in front of that workspace's page.
   **Amended 2026-11-09 (#1331):** an eligible new push requests the platform's `renotify` preference
   when replacing its conversation notice, keeping its coalescing tag. This requests another alert;
   browser support and OS settings still determine its display and timing.
6. **Where a push may be sent:** the image proxy's address rule (`https:` on the default port, no
   credentials, no address literal, no `localhost` or dotless host) and its checked public-address
   lookup, no redirect, a short timeout. A browser chose the endpoint; anybody signed in could choose
   any other, so the server must never reach inside.
7. **Managed in server administration** (amended 2026-11-09, #1325). Browser notifications are enabled
   or disabled in **Administration → Notifications**, without restarting. Migration 0097 adds the
   enabled state, public key, sealed private scalar, subject and independent env-import marker to
   `server_settings`. On first enable the server generates a P-256 pair; disabling retains it and the
   device registrations. Re-enabling uses the same pair. Existing complete `VAPID_*` values seed it
   once on upgrade, under the row lock; absent values seed it off. Later environment edits do not
   override the saved choice. The private key is bound to its column by `CredentialCipher`, never
   returned, logged or exported; restoring needs the database and its `ENCRYPTION_KEY`. An unreadable
   seal fails closed and is never silently replaced. Reads require the current server administrator;
   writes lock and recheck them, serialize generation and audit a real state change atomically.
   The sender reads the saved keys at device lookup and immediately before a provider request, on
   every node; no new provider request starts while off, including one already queued. Existing
   quiet-hour holds retain their normal expiry and unread checks. Requests already posted cannot be recalled.
   Off returns a null public key and refuses new subscriptions with `PUSH_UNAVAILABLE`. D-148's
   open-tab notifications and each person's browser permission remain independent. Visible clients
   recheck the key once a minute and on window focus; no browser permission is requested by the admin.
8. **Sent by the node that committed the write,** not through the `EventBus`: a second node does not
   double it (D-7).
9. **No dependency.** RFC 8291 and RFC 8292 with `crypto.subtle` (`docs/spikes/web-push.md`).

**Rejected.**

- *Pushing every unread notification of a message, on every send* — a retried send and an edit would
  ring the phone again for what it already said.
- *Message text in the push* — what a person wrote ends up on a lock screen; Phase 2 stops at who and
  where.
- *A language per device* — D-41 put the column on the person, the first text the server writes for
  them; a device subscribed in English and a person reading Turkish would disagree.
- *An allowlist of push-service hosts* — it breaks a browser we have not met; the address rule, the
  lookup and the per-person bound hold the abuse a stored endpoint allows.
- *Showing nothing while a Purlay window is open* — penalised by the browsers, as above.
- *The `web-push` package* — what it does, `crypto.subtle` does in Bun, measured against RFC 8291's own
  example (CONTRIBUTING §1.12).

**Not the credential cipher.** A push's body is encrypted to one browser's key in the one format a
push service carries (RFC 8291), on the wire and never stored; the credential cipher seals what
Purlay keeps (D-39 §6, #113). The test that holds "one cipher" names `modules/push/encrypt.ts` as
the second place, and why.

**Cost of reversing:** migration 0024's table and column, `modules/push`, four routes, the worker, the
account menu's item, and this decision; push can be disabled in server administration without a code change.

**Amended by D-307:** accepted browser delivery work, per-device attempts and admission now survive
restart in PostgreSQL; RAM wake-ups no longer own the work. Current source/device authority is checked
on every bounded attempt, and disabling cancels accepted work without cascading through busy devices.
