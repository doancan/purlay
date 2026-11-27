# D-239. The sign-in policy: two-step verification required of a password, and passwords turned off — builds on D-236, D-200, D-179 §4; closes #867

**Decided (the owner gave the decision to the maintainer, 2026-11-01).** D-236 made two-step verification
something each person with a password chooses; a server's administrator could not require it, and with single
sign-on connected (D-200) could not stop a password from being a way in at all. Two rules join who may sign up on
Administration → Server, each a column of `server_settings` (0068) and each changed on its own by
`POST /api/server/policy`, so two administrators changing two rules at once never undo each other.

- **Required of an account with a password — not of GitHub, single sign-on or a link.** What D-236 protects is the
  password; an account without one is signed into by a provider that owns its second step, and **a link counts as
  such a provider**: the mailbox is the factor, as D-236 already says in refusing codes by mail. An account is held
  to the rule when it has a password (a `credential` row with a hash) and password sign-in is on — whichever way
  this session was opened, since the password is a way in to it either way. With passwords off the rule asks
  nothing: there is no password sign-in left to protect.
- **Held back, not signed out.** Such an account with its second step off can still sign in with the password
  (there is nothing to ask for yet), and then every `/api` route, the socket's upgrade and `/api/server/*` answer
  `403 TWO_FACTOR_REQUIRED` — a code of its own, so a client tells it from a refusal of the resource — except what
  turning it on needs: `GET /api/me` (`mustEnrolTwoFactor`), `GET /api/me/sign-in`, the library's enable and
  verify routes and signing out. The hold is one seam, `requireSessionFromHeaders`, which every route reaches
  through `requireSession`, and the guard of Administration → Server; a route added later is held back unless it
  says it is part of the enrolment. It is read from the database on each request, so the first right code lifts it
  from the next request, on the same session (D-236 keeps that session). The web client draws only the enrolment
  card and **Sign out** while held back. While required, turning it off is refused (`403`, the library's shape).
- **Passwords off only while GitHub or single sign-on serves.** Turning password sign-in off is refused
  (`409 no-provider`) unless one of the two is connected and its secret opens; disconnecting the last of them while
  it is off is refused whatever `confirmLastChannel` says (`409 passwords-off`). The mail relay does not count: the
  setup's administrator's address may be one a link does not sign into (D-179 §4, R32), so a server with only a
  relay could lock its administrator out. Both rules are weighed inside the transaction that saves the change, from
  what it saved, under the row's lock: a policy change and a disconnect at once cannot both pass. Not a database
  check: a provider whose secret a rotated key cannot open is a column set and no way in (D-179 §6).
- **Off means off.** `/auth/sign-in/email` is `403 PASSWORD_SIGN_IN_DISABLED` for every address, before a password
  is weighed or counted, so it says nothing of any account; `/api/auth/methods` says `password: false` and the
  sign-in screen draws no password form.
- **The way back is the server's.** `bun run admin:reset-password` — already the break-glass for the administrator
  (D-179 §4, D-236) — turns password sign-in on again, on the trail, and says to restart the server, which reads
  its settings when it starts or changes them itself. A provider that went down, a key rotated past its secret or
  an administrator removed from the provider all end the same way: a password, a restart, and — where the rule
  requires it — the second step turned on again.
- **On the trail.** `server.two_factor_requirement_changed` and `server.password_sign_in_changed`, who and from
  which session, never the value (D-26).

**Considered and rejected.** Requiring the second step of every account (it would ask GitHub, single sign-on and
link accounts for a password they do not have, D-236). Counting a link as a password (a mailbox is the factor a
link already is). Signing a held-back person out instead of holding them (they could never turn it on). Letting
the mail relay keep passwords off (it can leave the administrator with no way in). A `CHECK` in the database for
the provider rule (it cannot tell a sealed secret that does not open, and would refuse `CONFIG.md`'s statement for
recovering from a rotated key). A separate break-glass command for passwords (the one that sets the password is
the one a locked-out administrator already reaches for).

**Cost of reversing.** Drop the two columns in a new migration and the gate in `requireSessionFromHeaders`; every
server then lets a password in, alone, as before.
