# D-244. How long a session lives: signed out after a time unused, and after a time at all — builds on D-11, D-60, D-193, D-239; closes #872

**Decided (the owner gave the decision to the maintainer, 2026-11-01).** A session lived `SESSION_TTL_DAYS` from
its sign-in, used or not, and the device list (D-193) let a person end one place by hand; a server's administrator
could not say *sign out a browser left unused* or *ask everybody to sign in again each week*. Two rules join the
sign-in policy on Administration → Server, each a column of `server_settings` (0073) and each changed on its own by
`POST /api/server/policy`, as D-239's are.

- **A small fixed set, both off by default.** Unused for 1, 8, 24 or 168 hours; at most 1, 7, 30 or 90 days old.
  The choices are `SESSION_IDLE_TIMEOUT_HOURS` and `SESSION_MAX_AGE_DAYS` in `@purlay/types`: the page offers
  exactly them and the server refuses anything else with `400`. Off is `null`, and every session then lives as
  before. The maximum age only shortens: `SESSION_TTL_DAYS` still ends a session that reaches it first.
- **Judged where the session is read, from its own row.** The library's `before` hook runs ahead of every one of
  its endpoints — our seam reads a session through its `getSession`, so every route of ours, the socket's upgrade
  and the library's own routes (`/auth/change-password`, two-step verification) meet it in one place. A session
  whose `last_used_at` is the timeout old, or whose `created_at` is the maximum age old, is deleted there and the
  library finds none: the answer is the `401` of a signed-out request (D-60 — nothing says why). Nothing is written
  into `sessions` when the policy changes, so a change reaches every session already open from its next request,
  and turning a rule off gives back a session it had not ended. One indexed read a request, and only while a rule
  is on.
- **Use is a request, and the page saying the person is there.** Every request the session resolves for refreshes
  `last_used_at`, as D-60 does, but every five minutes rather than every hour while a timeout is set; and the
  socket's `ACTIVE` (D-143) — sent on the person's own input while the page is in front of them — refreshes it the
  same way, since reading and writing over an open socket makes no request. A socket merely open is not use: a tab
  left open overnight is what the timeout is for. A session therefore ends up to five minutes before the timeout
  after its last use, never later. Use never revives a session the policy has already ended.
- **Ended as every end is.** The row is deleted only while it still says it lapsed — a statement that judges it
  again — so two requests at the instant end it once and a use that refreshed it in between keeps it; the sockets
  it held are sent `SESSION_ENDED { reason: 'expired' }`. A socket whose session lapsed with nobody asking — idle,
  or older than a maximum age set after it opened — is ended by the liveness sweep at its next check, within about
  half a minute; a socket's own timer is set to the maximum age where that is sooner than `expires_at`. The device
  list shows no session the policy ended, and the end it shows is the maximum age where that is sooner.
- **The native application alike.** Its session is minted by the handoff (D-191) as a row like any other and read
  through the same seam, so both rules apply to it; it signs in again by the browser as it does after a sign-out.
- **On the trail.** `server.session_idle_timeout_changed` and `server.session_max_age_changed`, who and from which
  session, never the value (D-26).

**Considered and rejected.** Free input of hours and days (a number nobody can check against a reason; a small set
covers what a team means). Better Auth's own `updateAge` (it slides `expires_at`, the absolute lifetime D-60 keeps
fixed, and the cookie would no longer say when the session ends). Writing a deadline into each session when the
policy changes (a write to every row, and a policy turned off could not give one back). Counting an open socket as
use (an unattended tab would never time out). Writing `last_used_at` on every request (D-60's argument). Ending
sessions the policy lapsed from a scheduled job (a session nobody presents harms nobody; `sweep:sessions` still
removes it at `expires_at`). Exempting the native application (a Mac left unlocked is the case an idle timeout is
for).

**Cost of reversing.** Drop the two columns in a new migration, the hook's check and the five-minute refresh; every
session then lives `SESSION_TTL_DAYS`, used or not, as before.
