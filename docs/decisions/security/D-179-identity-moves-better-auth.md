# D-179. Identity moves to Better Auth, and a server is set up in the browser — amends D-11

**Context.** The team goes live in one to two weeks. Today sign-in, sessions, workspaces and invitations
work and are tested (D-11, D-38, D-115, D-138, D-176), but three things a stranger needs are missing: a
server cannot be set up without editing `.env`, nobody can make an account from the site, and the first
administrator, GitHub, mail and the first workspace are four unconnected chores instead of one path. D-31
had already named `better-auth` as the library an identity provider would justify, and the owner
decided it is the library now. The owner's decision is not reopened here; this records how it is done,
what a spike measured before any of it was built, and what each earlier decision becomes.

**What the spike measured** (Better Auth 1.7.12, pinned exactly in the manifest; a scratch database,
nothing merged; its report is the record of every number below).

- *Q4, the Organization plugin on `workspaces`:* two owners stepping down at once left **0 owners** —
  I-2 broken, because the plugin reads the owners and then writes without a lock; a removal is not
  atomic with its hook, so a failed channel clean-up left the member already gone; the codes are its
  own (400, 401, 403) instead of D-111's 403, 404 and 409, and a non-UUID id reached Postgres as a 500.
  Its invitation is a different thing from ours (addressed to one email, with a role and a status; ours is
  a link with a token hash, D-115). It would need a second invitation model, a trigger for I-2, an
  error-translation layer and half of the plugin turned off. Cross-tenant, every crossing was refused.
- *Q2, the session token:* **the default stores the raw token** in `sessions.token_hash`. The cookie is
  the token plus an HMAC of it under the secret, so a dump alone is not a cookie — but a dump plus the
  secret is every live session, which is weaker than D-11 and fatal if the secret is ever kept in the
  database. Nothing built in hashes it (`storeIdentifier: "hashed"` covers verification rows only).
- *Q7, GitHub:* **the default takes the public profile email, not the primary one**, and an unverified
  primary signs up with `email_verified = false`. `disableSignUp` and refusing to link to an unverified
  account both worked as documented.
- *Q8, the first administrator:* with password sign-up closed, `auth.api.signUpEmail` is refused on the
  server too (`400 EMAIL_PASSWORD_SIGN_UP_DISABLED`); creating through the internal adapter worked.
- *Q9, the hourly limits:* counters kept in the database survived a real process restart (429 on the
  next attempt); the in-memory store did not (401), and is shared across instances in one process.
- *Also measured:* the secret is fixed when an instance is built (Q5), a replacement instance swapped
  into a holder serves the next request while an in-flight one finishes on the old one, and sessions
  survive while the secret is the same; `@purlay/db`'s Kysely is accepted as it is (Q6), and
  `transaction: true` is what makes a sign-up atomic; the session resolves on a WebSocket upgrade from
  the same cookie (Q3); `users` maps through `modelName` and `fields` (Q1).

**Decided.**

1. **Better Auth owns identity: `users` (mapped, not renamed), `sessions` (mapped and hashed, below),
   `accounts`, `verifications` and the rate-limit counters.** It is mounted on the Elysia server under
   `/auth`, its base path — as a `GET` and a `POST` route for `/auth/*` handing the request to its handler,
   since Elysia's `.mount` strips the prefix the library expects and a route for every method loses to the
   client's `GET *` (measured on 1.4.30) — and the version is held exactly, as every dependency is. The library's documentation
   (concepts/database) says its `migrate` command checks the database and adds missing tables and columns,
   and only for its built-in Kysely adapter. **That is not used here, and this is the decision's own rule,
   not a finding about the library:** we never run it, at runtime or otherwise, and `generate` is only a
   reference. The schema stays in numbered migrations (D-45), the single source, checked by Better Auth's own
   schema validation once the migrations are in — at boot after a migration on start, and by readiness —
   and a mismatch is a process that refuses to start or is never ready.
2. **What stays ours.** The `workspaces` module — workspaces, `workspace_members`, the roles and every
   rule of D-111, the audit trail — and its invitations, still links at `/invite#<id>` with the token
   hash of D-115. Tenancy is still read from `workspace_members`, keyed by the same `users.id` (D-21,
   D-54). **The Organization plugin is not used.** Q4 is the reason: its failures are in exactly the rules
   this product treats as non-negotiable, and making it pass means building around it. D-111 and the
   cross-tenant tests must stay green **unchanged**, and that is the check the code change is judged by:
   an identity change that needs either edited has touched what it should not. Better Auth does not hold a copy of anything the `workspaces` module holds (§6.1).
3. **Mechanisms we build and test, because the library does not do them.**
   - *A session-hash plugin* on the Kysely instance handed to Better Auth: every value bound to
     `sessions.token_hash` is SHA-256ed on the way in, and a result row keyed by the raw token gets the
     raw token back. D-11's property — a dump is not a session — holds with the secret too. The plugin
     has its own tests and an entry in `scripts/mutations/`. **The plugin is scoped to the `sessions`
     table**, and alone it broke the library's `revoke-other-sessions` into a silent no-op (reproduced
     in the spike's fix round 1), so that route is answered by an endpoint of ours: it deletes the user's
     other sessions by row `id` and never accepts a digest as a token. A session list or a revoke by row
     goes through our endpoint by the session's `id` for the same reason; its tests include
     `revoke-other-sessions`, change of password and password reset. The library deletes a session's row on sign-out and revoke, so `sessions.revoked_at` stays in the schema
     and is unused, and `audit_log.session_id` becomes `NULL` as it already does (D-116) — at once, when
     the session ends, since every way Purlay ends one deletes the row too (D-116 §4, as amended).
   - *A `getUserInfo` override for GitHub* that takes only the primary **and** verified address, and
     makes the username from the login there — an override skips the library's own `mapProfileToUser`.
     `github` is never in `trustedProviders` and `requireLocalEmailVerified` stays `true`. **An account has
     one GitHub identity, as it has one single sign-on identity (D-200 §3):** the library links a callback it does not
     know to the account whose address matches, so a second GitHub id carrying that address — an address taken
     over or recycled at GitHub — is refused where the `accounts` row is made (`identity_conflict`, shown as `failed`),
     whether the account holds another `github` row or only a `github_id` that `recordGitHubSignIn` would overwrite;
     the same write refuses it again under the row lock, for two callbacks at once. Only an account with no GitHub
     identity is linked by its verified address. **The
     username is never a client's.** The field is declared `input: true` only because the library's
     OAuth callback drops the fields marked `input: false` from a provider's profile and then fails
     the sign-in for the missing one; so a value a client sends could reach it, and a
     `databaseHooks.user.create.before` validates every username — lower case, `[a-z0-9-]`, at most 39,
     the first one free through `availableUsername` — shaping or replacing what it is given and never
     storing it raw (Ruling R23). `/update-user` is closed, so no later request can set one. The same
     hook supplies the username and display name for the magic-link path, which checks nothing and
     would otherwise be a 500 on `NOT NULL`.
   - *The first administrator through the internal adapter*: `createUser` and `linkAccount` (a
     credential account, the password hashed by the library) in **one** transaction, with
     `emailVerified = false`. The spike measured it with `true`; the design says `false` and wins (§7).
   - *A holder swap* for changing settings: a new `betterAuth()` is built from the saved settings and put
     where the handler is read, atomically per request. The secret is not a setting: it is derived from
     `ENCRYPTION_KEY`, the key the environment already requires at boot, with a purpose label of its own as
     D-62's state key is, so no new variable exists, and it is never stored in `server_settings` or edited in
     the browser, because changing it signs everyone out (Q5) and a dump with it is every session (Q2).
   - *Fixed configuration, from the spike:* telemetry off; the cookie named exactly
     `__Host-purlay_session` (`useSecureCookies: false` with `Secure` set in the default attributes —
     otherwise an https base URL prefixes `__Secure-` and the name is doubled); `database` as
     `{ db, type: 'postgres', transaction: true }`; `generateId: 'uuid'`; rate limiting **enabled** with
     storage `database` (its default is production-only); and a `databaseHooks.session.create.before` that
     turns the library's empty address into `null`, since `sessions.ip_address` is an `INET`. The
     library's schema check is asked of a fresh instance, never left to the serving one: the library runs
     it the moment an instance is built and keeps a mismatch for the life of the process, so a server that
     migrates on start refused every sign-in until a restart (measured by `migrate-on-start`'s two-process
     test). It is not asked inside transactional tests, and a test asserts the check itself. The session
     lasts `SESSION_TTL_DAYS` from sign-in and is never slid forward by use, as D-60's always was.
   - *GitHub's code is redeemed with its PKCE verifier.* The library sends a `code_challenge` (`S256`)
     with every authorization, and GitHub then requires the matching `code_verifier` with the code
     (docs.github.com, *Authorizing OAuth apps*). The token exchange is ours — through the injected
     `fetch`, with a deadline — and found in review to have dropped the verifier: every real sign-in
     would have been refused while a lax test double passed. The verifier is sent, and the double now
     checks it as GitHub does, so a test that passes is one GitHub would pass.
   - *A known limit of the library's state:* its cookie lasts five minutes and its row ten, so a person
     who spends between five and ten minutes on GitHub's page comes back to `expired`, whose sentence
     already says to start again; neither lifetime is ours to change.
   - *Every session the library ends is told to its sockets.* Its delete hooks announce each row
     after the commit, but they see only the rows the library read first — at most a hundred — and
     a failure of that read is swallowed while the delete goes ahead. So the five routes that end
     sessions (`/sign-out`, `/revoke-session`, `/revoke-sessions`, `/revoke-other-sessions`,
     `/reset-password`) are watched whole (`/change-password` ends the others itself, below): every session id of the person is read
     before the route and again after it, by the person and never as a list of ids, and each one gone
     is announced on its own, so one announcement refused never silences the rest. The cost is two
     indexed reads per such request, and a session announced twice, which the hub ends once. A read
     of the watch that fails is written down and never stands between a person and signing out.
   - *The library's log lines are ours.* Its logger writes through Purlay's: its message and the first
     error of its arguments, any address replaced and a driver's `detail` never copied; the rest of
     its arguments are counted, not written. `onAPIError.throw` is on, so an error that is not one of
     its answers reaches our error handler instead of its router's raw `# SERVER_ERROR` print — and
     since the library then logs no failure it answers itself, ingress writes each `5xx` it answers
     once, with the route, the status and its known code only, and
     sessions are read with their user in one statement (`advanced.database.joins`), since the
     library's adapter prints a failed second read raw and no option quiets it.
   - *A log line names a path under `/auth/` by the library's route, never as sent.* A path segment
     is the caller's to write, and a reset's token travels in one (`/reset-password/:token`); so the
     request line, a failure thrown under the library and a `5xx` it answers all carry the route as
     the library's own endpoint table spells it — the parameter left as `:token` — or `/auth/*` for a
     path it has no route for. The table is read off the instance (`Auth.routeOf`), never copied.
   - *A first sign-up lost to the same person's other tab is sent round once.* The library answers
     the losing tab `unable_to_create_user` with its state spent; where the other tab's account now
     exists, that tab is sent to `/auth/github` again with a one-shot `__Host-purlay_signin_retry`
     marker, and GitHub authorises without a prompt. A tab that loses again with the marker is told it
     failed. D-78's property, two sessions and one user, holds (Ruling R28).
   - *Sign-in by link is the library's magic link, with what it does not decide decided first.* It is
     installed only where there is a relay (`storeToken: 'hashed'`, `expiresIn` from
     `SIGN_IN_LINK_TTL_MINUTES`, its token Purlay's 64 hex digits). Its own two routes are closed:
     `/sign-in/magic-link` takes a display name and knows none of the rules here, and
     `/magic-link/verify` spends a link on a `GET`, which a mail scanner makes. Purlay's routes ask it
     through its API, which those closed paths do not reach: `sendMagicLink` never sends the library's
     `url` — it mails `APP_URL/sign-in/email#<token>` through the outbox, in the asker's language —
     and the page shows the address by reading the library's row by the token's digest
     (`magic-link:` and base64url SHA-256, measured), spending nothing. Who may be sent a link, the
     word to an account GitHub made, and the hourly limits are Purlay's (`modules/auth/magic-link.ts`):
     the library's own `disableSignUp` stays off, so whether a new address may become an account is
     decided in one place. A request is answered `202` once its two counts are taken, the same work for
     every address; the account is read and the link made only after the answer, so its time says
     nothing (D-138 §1, §6) — measured in review, a link made before the answer told a verified
     account from an unknown one in a single request. What is left for after the answers has no cap of
     its own: its bound is the two counters and the edge's `auth` budget, which every request passes
     first. A link a day past its expiry, and a counter a day
     old, are swept by `sweep:email-sign-ins`; `email_sign_ins`, which nothing wrote any more, is
     dropped (migration 0048).
     The limits are counters in `rate_limits`, keyed by a purpose and a digest — never an address —
     and taken in one statement, so requests at once cannot each see a stale count; a counter's
     `last_request` holds when its hour **closes**, because the library prunes that table by the column
     against the longest window it knows of, shorter than an hour. The library spends a link before it
     makes the account, so its spend runs in one transaction of the library's own
     (`runWithTransaction`): a spend that loses a unique index — the same new address by its other
     link, or another new address wanting the same name — is undone whole and tried once more, and
     finds the account, or the next name; without the second try the race tests fail on it.
   - *No provider token is stored.* The library has no option to leave them out (`encryptOAuthTokens` only
     encrypts them) and Purlay never calls GitHub for a person, so `databaseHooks.account.create.before` and
     `update.before` set the access, refresh and ID tokens and their expiry to `NULL`. `accounts` keeps the
     columns because the schema check demands them.
4. **The browser setup.** A server with no user is open to setup, and to nothing else:
   1. **A setup code.** The first start writes a one-time code to the log and stores only its hash; the
      wizard asks for it first. A wrong code is refused and counted.
      *As built (`modules/setup/setup.ts`, migration 0050):* twenty symbols drawn evenly from 32 that
      cannot be taken for one another (`2`–`9` and `A`–`Z` without `I` and `O`) — 100 bits — shown in five
      groups of four, and taken in any case, with or without its dashes and spaces. **Every start of an
      open server writes a new one**, in one line at `warn` under the field `setupCode` — the one secret
      logged on purpose, so that field is not on the logger's never-logged list, and the claim's token
      is — and keeps only its SHA-256; the newest code is the only one that opens, so one nobody used is
      replaced by the next start. No function returns it. **A code opens for an hour** from its start
      (Ruling R39); after it the right code is answered, and counted, as a wrong one, so a code found
      later in a kept or shipped log is dead. **The throttle is the server's**, not an address's, since
      the code is the server's secret: the fifth wrong code locks every claim, the right code included,
      for fifteen minutes; the count is kept by the database under the row's lock; a refusal while
      locked is not counted; a lock that runs out starts the count again. **The lock belongs to the code**
      (Ruling R40): the next code, written at a start, begins with no count and no lock, and five
      guesses at 100 bits per forced restart are worth nothing. That undoes only a **slow** stranger: one
      who keeps sending wrong codes locks the new code five requests after each start, and neither a
      restart nor the statement `CONFIG.md` gives to clear a lock lets the operator in. The cost is
      that whoever can reach `/setup` can keep it locked by guessing; the answer is a limit per client
      on the route, which comes with the endpoint — **a requirement of the `/setup` endpoints**, not an
      option, and built (§4.10: ten codes in fifteen minutes from one client) — and an operator who
      blocks the source.
   2. **A claim lock.** The moment the code is accepted, setup is bound to that one browser; a second
      browser sending the code at the same time is refused, and exactly one wins. A browser that closes
      and returns resumes at the step it reached, in the same claim; a half-written setting never stays.
      *As built:* the row is locked while a code is weighed, so of two right codes at once one claims and
      the other is refused as `claimed` (measured, 25 rounds); the claim **spends** the code, so the same
      code from any browser afterwards is refused. The winner is handed a random token once — for an
      `HttpOnly` `__Host-` cookie — and only its digest is kept; every later step is guarded by it
      (`requireSetupClaim`), and a missing, wrong, replaced or idle token, or a closed server, is the one
      refusal, compared in constant time. The steps are a closed set, `SETUP_STEPS` in `@purlay/types`
      (claim, admin, address, policy, github, email, workspace, invite, finish — the policy chosen on the
      address's screen, `UX.md` §11), passed in order; passing
      one again changes nothing, and `finish` is written only by the finish rule, with
      `server_settings.setup_completed_at`. **Abandoned or lost:** a claim whose browser has not been
      seen for a day no longer opens. A browser without the token — another one, cookies cleared, a day
      gone — needs a code, and the code is spent: the operator restarts the server and enters the new
      code from the log, which **takes the unfinished setup over at the step it reached — only once the
      claim has gone unseen for fifteen minutes** (Ruling R39; seen means the guard passed or a step
      was recorded). A claim seen within them is refused to every code, a fresh right one included,
      which the refusal does not spend; so a crash, a deploy or a restart that writes a new code while
      an operator works hands their setup to nobody who reads the log afterwards. The browser that held
      a claim taken over is refused from its next request. An operator who lost the browser waits at
      most fifteen minutes and a restart.
   3. **The administrator** gives a name, an address and a password, and signs in with them. The address
      starts **unverified**: whoever knows the code runs the server, but has not proved the address is
      theirs, and one mistyped could be claimed through GitHub. It is verified when the link in the mail
      step is followed — a one-time mail of the wizard's own, its token kept as a hash, and **never the
      library's magic link**. The library's documentation (plugins/magic-link) says a magic link that
      verifies an account whose address was never confirmed removes its password and revokes its
      sessions, and on 1.7.12 it does more, measured against the real tables: every `accounts` row of
      the account goes — the password **and** a linked GitHub account — its sessions are deleted, a new
      one is opened and `email_verified` becomes `true` (`revokeUnprovenAccountAccess`). The setup
      administrator is exactly such an account. So **no magic link reaches an account whose address is
      unverified**: asking for one sends nothing and is answered `202` as for any address; a link
      already in a mailbox when such an account appears at its address is refused as one that does not
      open, before the library is asked; and should anything reach the library past that, two hooks of
      its own (`account.delete.before`, `user.update.before`, on its spend's route) refuse the
      promotion, and the spend's transaction undoes the rest (`magic-link-guard.integration.test.ts`).
      Without mail, a
      password is reset by a command on the server (`bun run admin:reset-password`), which the wizard
      names when mail is skipped. Password sign-up stays closed to everybody else.
      *As built (`modules/setup/admin.ts`, `modules/auth/password-attempts.ts`, `@purlay/types`
      `password.ts`):* **the step.** `createAdmin` needs the claim this browser holds, weighed again under
      the row's lock, and the setup standing at `claim`; once an administrator is recorded a second is
      `admin-exists`, whatever it is called (five at once make one). In **one transaction** of ours, the account is made through
      the library's own adapter pointed at that transaction (`kyselyAdapter` over it, `runWithAdapter`) —
      `createUser` with `emailVerified = false`, so its user hook names it by the rules every account is
      named by, and `linkAccount` with a credential: `provider_id` `credential`, `account_id` the user's
      own id, the library's scrypt — then `users.is_server_admin`, `setup_state.admin_user_id` and the
      `admin` step; a failure anywhere leaves no user, no password and no administrator (measured). The
      address is one mailbox (`normalisedMailbox`), the name 1–128 characters after trimming with no
      control or format character, an address an account has is `email-taken`; each is a typed refusal
      before anything is written; the password is hashed only past every refusal, inside the
      transaction, so nobody without the claim makes the server spend scrypt. Only the account's id comes
      back. The administrator is then signed in by the library's own `/sign-in/email`
      (`Auth.passwordSignIn`, through `signInAdmin`, which requires the client's address so the attempt is
      counted as the route's are): its cookie, its session row, hashed at rest — no session is made by
      hand, and only the answer's `Set-Cookie` is for the browser, since its body carries the raw token. A command that resets a password writes the same row shape
      (`credential`, the user's id, `hashPassword` of `better-auth/crypto`), and the library accepts it
      (tested). **The policy**, one home in `@purlay/types` and read by the setup, the library's options
      and its hook: 10 to 128 characters (the library's `minPasswordLength`/`maxPasswordLength` are set
      from the same constants, so its sign-in, change and reset agree); no control character and not
      blank; compared after NFKC and lower case, not containing the address, its local part (four
      characters or more), the display name or any word of it (four or more); not one of a short list of
      the commonest passwords of ten or more, nor one of them with digits or marks added at its end
      (`Password123!`); at least four different characters. No breach lookup, no network call. A change of password or a
      reset is held to it by a `before` hook (`400 PASSWORD_TOO_WEAK` with the reason, said to the
      account's holder only), before the current password is weighed. **Sign-in with the password**
      works for the unverified address: `requireEmailVerification` stays off, and a change of password
      always ends the person's other sessions — but not the caller's own: the hook forces the library's
      `revokeOtherSessions` **off** (on, the library deletes and replaces the caller's session, and the
      open page is told its session ended before the new cookie reaches it), and an `after` hook, on a
      success only, deletes the person's other sessions by row id in one statement and tells exactly
      those ids to their sockets (§3). If that step fails after the password changed, the answer is
      `500 OTHER_SESSIONS_NOT_ENDED`, written down redacted: the password did change, the other sessions
      stand, and the page says to use *Sign out everywhere*. **No enumeration:** an unknown address, an account with no password and
      a wrong password are one answer — `401 INVALID_EMAIL_OR_PASSWORD`, body and headers alike — and one
      cost: the library hashes the password it was given for an address it does not know (1.7.12,
      `sign-in.mjs`), measured over sixty interleaved samples each at a median of 32.91 ms for a known
      address and 32.64 ms for an unknown one before this work, 33.36 and 33.35 after it, so no dummy hash
      of ours is needed; the timing test stays to say so if the library changes. **The throttle is on
      wrong guesses, and is not a lockout.** A client is a **network**: an IPv4 address, or an IPv6 /64
      (`limitKeyFor`, the edge's key too) — one subscriber's allocation, whose host bits are theirs to
      rotate, so a key per IPv6 address would be a fresh budget per request (found in review: 25 rotated
      hosts of one /64 had every guess weighed). An attempt is counted before the password is weighed — in
      `rate_limits`, one statement each, so attempts at once cannot all pass a count that has not moved —
      and given back unless the library answered a wrong password (`INVALID_EMAIL_OR_PASSWORD`,
      `INVALID_PASSWORD`): a sign-in that works spends nothing. Ten wrong for an **address from one
      client**, twenty from one client whatever the addresses, in fifteen minutes; past either the answer
      is `429 RATE_LIMITED` with `Retry-After`, and the password is not weighed, the right one included.
      The address is never counted alone: a count per address, whoever sends the guesses, would let a
      stranger spend the administrator's allowance from anywhere and keep them out with the right
      password — a lockout anybody can cause. So a stranger's wrong guesses use up only the stranger's
      own. **The residual risk this accepts:** a guesser spread over many networks — many IPv4
      addresses, many IPv6 /64s — has ten tries at an address from each network every fifteen minutes,
      and there is no ceiling for the address across networks, since any hard one would hand a stranger
      the lockout this refuses; the policy and the hash's cost are what stand against it. `/change-password` counts its wrong current passwords with the
      sign-in's. The library's own rule for those two routes (three requests in ten seconds, successes
      counted, `X-Retry-After`) is switched off (`customRules`), so the throttle has one home and one
      answer; the edge's `auth` budget still bounds every request first. A password over 128 is refused
      by the library before it is hashed and is not counted; a body past the edge's bound is `413` before
      it is read. **The library's password routes**, every one of its endpoint table whose path or body
      names a password, each decided and held by one test that fails when an upgrade adds another: open
      and counted, `/sign-in/email` and `/change-password`; open and held to the policy, `/reset-password`,
      whose token no route issues; **closed** (the API's `404`), `/verify-password` — it says whether a
      password is the session holder's, so a stolen session would guess the password behind it, found in
      review answering 25 wrong guesses and then the right one — `/delete-user` (an account is erased by
      Purlay's own route, D-139 §5) and `/request-password-reset`, so no token for a reset is ever issued
      over HTTP; `/reset-password/:token` takes no password; `/sign-up/email` answers
      `EMAIL_PASSWORD_SIGN_UP_DISABLED`; `setPassword` is the library's API alone, with no route and so no
      hook to hold it to the policy, and a test holds that nothing of ours calls it. An erasure deletes the account's `accounts` rows — the password's hash with them — and
      the wrong-password counters under its address.
      **The address check** (`modules/setup/verification.ts`, migration 0051, Ruling R32): one link,
      `APP_URL/setup/verify#<token>` — the token in the fragment, as every link's is — mailed in the
      e-mail step as the very letter the relay is tried with (§4.4). It is issued only under the claim,
      for the administrator the setup recorded, while the address is unverified; a new one replaces the
      one before it. The token is 256 bits, handed back once for the letter, and only its SHA-256 is
      kept, in a table of one row (`admin_email_verification`) that names the account itself — not in
      `setup_state`, because the letter may be opened after *Finish*, which forgets the administrator and
      spends the claim. Following it needs no claim and no particular browser: the token is compared
      with the digest in constant time, opens for **a day** from its issue (one issued "in the future",
      a clock moved back, does not open), and is spent in the transaction that sets
      `users.email_verified` — so of two clicks at once one verifies: the row is locked while it is
      weighed, and, should the lock ever go, only the click whose `DELETE` removed the row may mark
      the address (both held by a test that makes the second click wait on the first). The row keeps
      the address it was mailed to, and a link followed after the account's address changed verifies
      nothing. An unknown, spent, expired or wrong link, or one whose account was erased or whose
      address changed since, is one refusal, with nothing to tell them apart; a wrong guess spends
      nothing; a link tried past its day is deleted, and the daily `sweep:email-sign-ins` deletes one
      nobody tried. Erasure deletes the row (its key's `ON DELETE CASCADE` does not see a soft
      deletion), and it is never exported.
   4. **The server address, GitHub and mail are each tried before they are saved.** GitHub is called
      with the pasted values and mail is sent a test message; a failure is answered with what happened,
      how to correct it, and the service's own reply, as one of a closed set of reasons. A step may be
      skipped, and says what then stops working.
      *As built (`modules/setup/probes.ts`; the reasons are `PROBE_REASONS` in `@purlay/types`):* each
      probe takes the **candidate** values and reads and writes no setting; the endpoint saves only
      after `ok: true`. **GitHub:** a `POST` to the token endpoint under `GITHUB_URL` — the base every
      sign-in uses (Ruling R36) — with the client id, the secret and a code GitHub never issued
      (`purlay-setup-probe-never-issued`), no `redirect_uri`, bounded at ten seconds like a sign-in's
      calls. GitHub weighs the app before the code, so `200 {"error":"bad_verification_code"}` says the
      pair is good and only the code was refused (documented; not measurable without a real app's
      secret, so held by the strict stub); `200 {"error":"incorrect_client_credentials"}` is a known app
      with the wrong secret, **`secret-rejected`** (measured against github.com on 2026-10-22 with a
      public app's id); an id GitHub does not know is answered **`404 {"error":"Not Found"}`** —
      measured, and not in GitHub's documentation, which names `incorrect_client_credentials` for "the
      client_id and/or client_secret" — **`client-unknown`**. No code a person was given is ever sent,
      and a token, should anything hand one back, is neither kept nor shown (`unexpected-reply`).
      **What it cannot try: the callback address.** GitHub checks it on its authorize screen, which only
      a browser reaches, and the probe sends none — the parameter is optional at the token endpoint, and
      sending one would add a check whose order against the code's cannot be measured without a real
      app — so `callback-mismatch` is not a reason: the wizard shows the exact address to paste,
      `APP_URL/auth/callback/github` (Ruling R35), and says what GitHub's own error page means (Ruling
      R47). **Mail:** a transport built from the candidate address as every relay's is
      (`transportOptions`: TLS required past this machine unless the operator says the link is
      private), asked whether it answers — nodemailer's `verify()`: DNS, connection, TLS, login — and
      then sent **one** letter, the administrator's own verification letter (§4.3), so a relay that
      refuses the sender or the message is found here rather than at the first invitation. Each phase
      is bounded at ten seconds (DNS, connection, greeting, silence) and the whole try at twenty;
      nothing is retried. The reasons follow nodemailer's codes as measured on 10.1.2, where they differ
      from its error reference: a refused connection, a host that does not resolve and a timeout are
      **`unreachable`** (`ESOCKET` with `ECONNREFUSED`, `EDNS`, `ETIMEDOUT`); an untrusted certificate is
      **`tls-failed`** — reported as `ESOCKET` with the certificate's code in `originalCode`
      (`DEPTH_ZERO_SELF_SIGNED_CERT`), not the `ETLS` the reference names — as are `smtps://` to a plain
      relay and a relay past this machine that does not offer the upgrade (`ETLS`); a refused login is
      **`auth-failed`** (`EAUTH`); a refused `MAIL FROM`, `RCPT TO` or message is **`sender-refused`**,
      **`recipient-refused`** or **`message-refused`**; a greeting that is not SMTP, and anything else,
      is **`unexpected-reply`**. **The reply** shown with a reason is the service's own words, trimmed to
      200 characters, with every spelling of what was tried — as typed, escaped, and in base64 as `AUTH`
      sends it — an address's credentials and anything token-shaped taken out, so a relay or a GitHub
      that echoes a login shows none of it; the spellings are the secret as typed, inside a JSON string
      (the probe's own request body, echoed), percent-escaped, form-encoded, and in base64 with and
      without its padding. **What a hostile answer cannot do** (found in review, fix round 1): GitHub's
      reply is read no further than 8 KB (a stream that never ends is cut, a `Content-Length` past it
      is not read), and **no redirect is followed** — a `307`/`308` would re-send the body, secret
      included, to wherever `Location` points, and that origin's answer would have decided the try;
      every 3xx is `unexpected-reply`. The same holds for a sign-in: `GithubFetch` requires
      `redirect: 'manual'` of every call (the token exchange, the profile, the addresses), a redirect
      is GitHub failing the sign-in, and each reply is read no further than 64 KB. (Bun drops
      `Authorization` on a redirect to another origin, measured, so the workspace unfurls' bearer
      token is not carried off; their bodies carry no secret.) A relay's conversation still running at
      the deadline is cut — the probe opens the sockets and hands them to the transport, since
      nodemailer's `close()` lets go of none — so no probe leaves a socket open. The sender is one
      plain address (`normalisedMailbox`, no name, no line break) or the try is refused before it
      starts, as an address no transport can be built from is (`CandidateRefused`, for the endpoint to
      answer as invalid input). **A relay with a private certificate** is refused (`tls-failed`);
      nothing turns the check off, and the operator gives the server the authority with
      `NODE_EXTRA_CA_CERTS` (`CONFIG.md`; measured to work with Bun and nodemailer) or uses a relay
      with a public certificate. **Who may run a probe is in its type** (Ruling R48): each takes a
      `ProbeAuthority` first — a `SetupSession`, minted only by `requireSetupClaim`, or a
      `ServerAdminSession`, which only Administration → Server's guard will mint — branded by symbols
      their module does not export, an assertion into either refused by lint (`verify:enforcement`
      proves it). **Where the probe connects is the claim holder's to say.**
      The relay's host is typed by whoever holds the setup's claim, who proved they run the server by
      reading its log; the probe connects wherever that is, internal relays included, with no allow or
      deny list that would refuse a legitimate one — only while the setup is open, and only for the
      claim's holder (the endpoint requires the claim).
   5. **The finish rule.** *Finish setup* is refused until at least one way for **other people** to sign
      in is connected **and tried**: GitHub's app accepted by the probe (§4.4), or a relay that took the
      test letter — so a server nobody but its administrator can sign in to never counts as set up. The
      administrator always has the password, so signing in through the channel is not asked (Ruling
      R47: a GitHub sign-in to the unverified administrator is refused by design, §4.3). It is enforced
      by the server, not only the button.
      *As built (`modules/setup/wizard.ts`, migration 0052):* the setup remembers when it saved each way
      in after a try that worked (`setup_state.github_tried_at`, `email_tried_at`, written with the
      step), and the finish counts a way only when it was so saved **and** serves now (the instance has
      the GitHub provider, or a relay): an app or a relay merely in the settings — seeded from the
      environment, never tried — does not count, nor one a rotated key left unreadable. With it: every
      step before the finish passed (the invitations, skipped or not, the last) and the first workspace
      there. Every reason that holds is listed to the holder (`SetupState.finishProblems`); the finish
      itself is refused with the first, and calls `completeSetup` in the same transaction.
   6. **Without mail** (GitHub only): email sign-in, inviting by email and *create an account by email*
      are hidden, the invitation step only copies the link, and a link already works without any mail
      (D-115).
   7. **The default is invite-only**, and the one choice made in setup is invite-only or open.
   8. **After setup** `/setup` answers as a closed door on a server with any user, and the settings are
      managed in **Administration → Server**, with the same try-first probes.
      *As built:* closed rests on **two facts, either enough**: `server_settings.setup_completed_at` is
      set — the one home of "setup is finished", written only by `completeSetup` and never cleared (a
      patch clearing it is refused by its type and by the server) — or a user exists **other than the
      administrator an unfinished setup made** (`setup_state.admin_user_id`), so the wizard's own
      administrator, made at its second step, does not shut it halfway. Finishing, in one transaction,
      sets the first, clears `admin_user_id`, records `finish` and spends the claim — so afterwards every
      user, the administrator too, keeps the door closed, and a lost or restored settings row reopens
      nothing. **Only a server with no user at all is open, and that is a fresh install.** A server that
      had people before this version is closed from its first start. Closed, every setup function
      refuses; each start clears what an unfinished setup left (code, claim, count, lock), writes no
      code and says `setup is closed` instead. **One allowance (Ruling R42):** while the finish is not
      written, users who arrived during the setup — an invitee who accepted before *Finish* — close it
      to everybody but the browser holding a valid claim, which may still pass its steps and finish, so
      the door ends on both facts; a start then keeps that claim and clears the rest.
      *Administration → Server, as built* (`modules/setup/server-admin.ts`, `ingress/http/server.ts`,
      `API.md` §2 `/api/server/*`). **One guard** — `requireServerAdmin`, the only thing that makes a
      `ServerAdminSession`, the other authority the probes take (R48) — reads the request's own session and
      then `users.is_server_admin` and `deleted_at` from the database each time; a workspace role proves
      nothing, and nothing in the request can say it. **Everybody else is `404 ROUTE_NOT_FOUND`**, signed
      out included: the repo's convention for what is not for a caller is absence (`SETUP_UNAVAILABLE`,
      `WORKSPACE_NOT_FOUND`), and a `401` would tell a stranger that the route exists. **A change is the
      wizard's machinery**: tried with the candidate under the administrator's authority and kept and
      served by `applySettings` only when the try worked — and the wizard's `tried` flags are **not**
      used: they exist for the finish rule of a setup that is open, so the routes refuse while it is
      (`409 SERVER_CHANGE_REFUSED`, `setup-unfinished`), which is also what keeps a change made here from
      leaving a flag describing a pair that was never probed; `canFinish` is never consulted. **The
      relay's test is a plain letter to the administrator's own address**, not the address-proof link.
      **Never the last way in by accident**: disconnecting GitHub or the relay is refused (`last-channel`)
      when no other way for other people to sign in would remain, unless the administrator says
      `confirmLastChannel`; the rule is weighed inside `applySettings`' own transaction, from what that
      transaction saved, so two disconnects at once cannot both pass. **Every change is on the server's
      trail** (`server_audit_log`, migration 0054): `audit_log` is a workspace's and requires one, and
      these settings belong to none; the row is written by `applySettings` in the same transaction as the
      save (its `alongside` hook), so it exists exactly when the change does, and holds the actor, the
      session and the action — never the value. A limit per client, sixty in fifteen minutes, is charged
      before the session is looked at. **The password's recovery is `bun run admin:reset-password
      <email>`** (`modules/setup/reset-password.ts`): the break-glass for the server administrator only —
      any other address is refused in the words an unknown one gets — with the new password read from the
      terminal (nothing shown, asked twice) or from standard input, **never an argument or the environment**
      (a second argument is refused unrepeated); the policy applies; the credential row is written as the
      library reads it (R10); and every session of the account ends in the same transaction. It works on
      the database `DATABASE_URL` names, the real one included: that is what it is for. It leaves a row
      on the server's trail (`server.admin_password_reset`, the account itself as the actor, no session,
      never a value) in the same transaction. **Open real-time connections end within about half a
      minute**: the command is a process with no bus, and the hub resolves a socket's identity once, so
      the hub's **liveness sweep** (`realtime/liveness.ts`) asks, every 30 seconds and in one query
      (batches of at most a thousand sessions, never one per socket), about the sessions of all open
      sockets, and ends — with the `SESSION_ENDED` frame and close code every other end of a session
      uses — each whose session row is gone, expired, or whose account is erased; a query that fails
      closes nothing and is tried again at the next tick, and the timer neither keeps the process alive
      nor survives shutdown. That is also what ends the sockets of any session an operator removes by
      SQL. A GitHub secret or relay address the key cannot open can be disconnected (`needsReentry`
      counts as connected for that), under the same last-way-in rule, which clears the ciphertext.
   9. **A changed setting takes effect without a restart** (Ruling R37; *as built*,
      `modules/setup/runtime.ts`). What the wizard and Administration → Server change — GitHub's app, the
      relay, who may sign up, who may make a workspace — is applied by `applySettings`, which in **one
      transaction of its own** saves the patch, reads the whole row back as a start would, builds a new
      library instance and relay from it (`runtimeServicesFrom`, the start's own function; nothing is
      connected), and asks the new instance the library's schema check. A failure at any of these rolls
      the save back and the old pair serves on. Only once the commit is confirmed is the new pair swapped
      into the holder — one synchronous assignment that cannot fail — so the database and the process
      disagree for no longer than that step, and a process that dies at any point leaves the database as
      the next start should read it. The instance is **replaced, never edited**: the library fixes its
      providers and plugins at construction (Q5), so the GitHub provider exists exactly when the settings
      hold an app and the magic-link plugin exactly when they hold a relay, both ways; who may sign up is
      built in too, and rebuilt with the rest. Who may make a workspace is read per request and would need
      no rebuild; every change rebuilds the pair anyway, at about half a millisecond.
      - **What never changes at run time**: the secret sessions are signed with (derived from
        `ENCRYPTION_KEY`), so **every session outlives a swap**; `APP_URL` and where GitHub is
        (`GITHUB_URL`, `GITHUB_API_URL`), which stay in the environment (§6). The library's in-memory rate
        counters are process-wide and its database ones shared, so a swap hands no attempt back.
      - **A request is served by the pair it started on.** The application holds a stand-in that reads, on
        every use, the pair the request **pinned at its first hook** (`AsyncLocalStorage`, the same
        mechanism the request's log scope uses): a request in flight during a swap finishes on the old
        instance, what it leaves for after its answer posts through the old relay, and the next request
        is served by the new one. A socket's admission and its open each pin their own. The stand-in, not
        an accessor passed to every handler, because over a hundred handlers take the instance as a value
        and the pin makes each of them correct without a change; it is typed as the library's instance and
        holds no `any`.
      - **The replaced relay is let go cleanly**: its letters still on their way are waited for (two
        seconds at most), then its transport is closed. Every relay the process built counts its sends
        in one ledger, which the shutdown waits for after the drain and before the pool closes
        (`closeAfterDrain`, `lifecycle.ts`), so a letter posted to a replaced relay — even after it was
        closed, by work pinned to it — is not cut off. That last part rests on the transport being
        **unpooled** (a connection per letter; `close` holds nothing back): a test sends a letter through
        a closed transport, so pooling it would fail first. The
        old instance has no timers and no dispose; it is garbage once its last request ends (a hundred
        swaps measured: no instance, timer or relay connection left).
      - **Two changes at once run one after the other**, the second built from what the first saved, and
        not begun until the first has let its replaced relay go. A change before the start has read the
        settings is refused (`starting`), one once the process has begun to drain is refused
        (`shutting-down`: a pair built then would be dropped a moment later; a change already under way
        finishes, the drain waiting for its request), and so is one handed a caller's transaction, whose
        commit would not be its own to wait for.
      - **How long an old pair lives**: until the last flow pinned to it ends — a request and what it
        left for after its answer, a socket's admission or open, and any timer started inside one of
        those, which carries the flow's pin with it (so at most a socket's lifetime). Then it is
        garbage. Nothing else holds it: the hub and the edge hold the holder's stand-in, not an instance.
      - **A GitHub sign-in started across a change of GitHub's app fails at the callback**: GitHub issued
        its code to the app the browser was sent to, and the new instance redeems it with the new app's
        credentials, which GitHub refuses. The person lands on the sign-in screen with that sign-in's
        failure and simply signs in again (which reason GitHub's refusal maps to was not measured against
        github.com). Sessions are not affected; only a round trip in flight at that moment.
      - **The failure mode, said, never half-swapped** (`SettingsChangeFailed`, by stage): `save`, `build`
        or `verify` — nothing saved, the old settings serve; `commit` — the database did not confirm, so it
        may or may not hold the change while the old pair serves: **restart the server**, and the start
        serves what the database holds; `retire` — the change serves, the replaced relay could not be
        closed: restart to release it. **No restart fallback is built** (§9: Q5 passed); restarting is the
        recovery the two last stages ask of the operator, in words.
   10. **Over HTTP** (*as built*, `ingress/http/setup.ts`; the contract is `API.md` §2 `/setup/*`).
      **One guard**: every route but the status, the claim and the address link takes the claim's
      cookie (`__Host-purlay_setup`, `HttpOnly; Secure; SameSite=Strict; Path=/`, a day's `Max-Age` —
      the claim's idle limit — sent again on every pass, cleared by the finish) through
      `requireSetupClaim` before it reads its body. **One answer to everybody without the claim**: closed, never claimed, claimed by another
      browser, a cookie wrong, idle or taken over — `404 SETUP_UNAVAILABLE`, the same body and headers
      and, measured over forty interleaved samples each, the same time (about a millisecond); the claim
      tells apart only a wrong code (a field's `400`) and the lock (`429 SETUP_LOCKED`, `Retry-After` to
      its end). `GET /setup/status` says `{ open, appUrl }` and nothing else: the address the server is
      configured for, which the page compares with its own origin before a code is sent (Ruling R35 —
      a browser on another origin is refused as cross-site, so the warning cannot wait for the claim;
      the request's `Host` is no guide behind a proxy that rewrites it). The browser's id is the server's
      own. **Limits per client** (`limitKeyFor`: an address, or an IPv6 /64), charged at the edge before
      the claim is looked at or a code weighed: the claim and the address link ten in fifteen minutes,
      every other step thirty, the status with the sign-in traffic, a `HEAD` as the `GET` it runs; the server's lock on wrong codes
      stays, and the limit is what keeps one client from holding it shut. A cross-site `POST` is refused
      before all of it (D-39); every answer is `no-store` and `noindex`. **Steps in turn**: a step is
      refused (`409 SETUP_STEP_REFUSED`, `out-of-order`) unless every step before it is passed —
      checked before anything is tried, so a probe out of turn calls nobody and saves nothing. The
      policy is chosen on the address's screen, so its step follows the address (`SETUP_STEPS`;
      `UX.md` §11, step 3). **Tried, then kept**: GitHub's app and the relay are saved only when the
      try worked and the caller asked to keep it (`save`), through `applySettings` — the swap of §4.9 —
      and a change that fails is said by its stage (`500 SETTINGS_CHANGE_FAILED`, or `503` while
      starting or shutting down), never its value. The relay is tried with the administrator's address
      letter; an address already verified is sent a plain test letter, since there is no link to send.
      The relay's address (`smtpUrl`) connects wherever the holder says, internal hosts included —
      the claim is the boundary (§4.4).
      **The first workspace** is made under the claim for the administrator, through the workspaces
      module with `#general`; who may make a workspace (`WORKSPACE_CREATORS`) is not asked, the claim
      being the authority and the administrator the person that rule exists to let in first; asked
      again, the one made is the answer. **The administrator** is made and signed in by the library,
      and only its `Set-Cookie` reaches the browser, never its body. **The address link**
      (`POST /setup/verify`) needs no claim, outlives the finish for the link's day, and refuses
      everything that is not a well-formed token before hashing it, as one answer
      (`404 ADMIN_LINK_NOT_FOUND`). **Nothing secret is written**: the request fields are `code`,
      `password`, `clientSecret`, `smtpUrl` and `token`, all on the logger's never-logged list, and a
      test reads every line of a whole setup for the code, the claim's token, the passwords, the
      secrets and the link.
5. **Sign-up and linking.** "Create an account" is on the site (the sign-in screen and its own screen).
   - *Open* lets anyone with GitHub or an email address make an account. *Invite-only*, the default,
     lets in only a person holding a valid invitation, by GitHub or by email alike; an invitation is the
     exception to the closed door, not a way around it.
   - *The same verified address is one account*: a GitHub sign-in whose primary, verified address is a
     verified local account's links to it. Neither side is linked while its address is unverified, and an
     address GitHub keeps private or unverified is never used. This replaces D-138 §2–§3 and the
     connect flow of D-176 (below). What D-138 §2 says of an account **GitHub made** stands: a link is
     never sent into it — the address is sent a word to sign in with GitHub — since whoever holds a
     mailbox the GitHub account no longer uses would otherwise be let in; linking runs one way, from a
     GitHub sign-in to a verified local account.
   - An account made by email link has its address verified by that link; an invitation accepted by an
     account with an unverified address is refused until it is verified. The invitation stays a link
     that whoever holds it can use (D-115); a link carries no address to match, so none is. **"Invitation
     by verified address" therefore means the *account's* address is verified, never that it matches the
     invitation's.**
   - **Invitations by email are the bearer link, sent.** The owner asked for invitations by email, and the
     prototype had address chips and a role chosen per invitee. In this form both are **dropped**: no role
     at invite time (the person joins as `member`, D-115 §3, and is promoted afterwards by D-111's rules)
     and no binding of a link to an address. Where mail is configured the message carries the same link
     through the existing mailer; otherwise the link is copied. This is the builder's call, and the owner
     is told in the report that closes this work. **Bounds and wording:** one request makes one link and
     names at most twenty addresses (repeats in any case dropped); an inviter has fifty letters a day and
     a workspace two hundred, counted in `rate_limits` so a restart hands nothing back, and a request that
     fails gives back what it took. Letters are posted after the answer, so the answer says only *queued*
     (the screen: "asked the mail server", never "sent" or "delivered"), a failed send is logged by its
     code, and the link is always answered too; whether an address is already a member is neither
     looked up nor said, since members' addresses are not shown to one another. The subject is fixed
     and the names in the body are cut and stripped of line breaks, control characters and web addresses.
   - **The exception is a passport** (Ruling R51; *as built*, `modules/workspaces/invitation-passport.ts`,
     migration 0053). On an invite-only server a newcomer asks `POST /api/invitations/passport` with the
     link's token — public, charged per client — and is given a **passport** made from a link that opens,
     refused with the preview's own `404 INVITATION_NOT_FOUND` otherwise. By GitHub the passport is a
     `__Host-purlay_invite` cookie (`HttpOnly; Secure; SameSite=Lax; Path=/`, an hour; `Lax` because it
     must survive the redirect back from github.com); by email it is for the address typed with the token,
     with no cookie, since the mail's link may be opened in another browser. Only the digest of the cookie
     or of the lower-cased address is stored. The sign-up spends it: `databaseHooks.user.create.before`
     — which GitHub's provider is never switched off ahead of (`disableSignUp` is `false` always) — lets
     the account be made on GitHub's callback with the cookie, or on the spend of an email link for
     exactly that address, and spends the passport **in the transaction that makes the account**, by one
     update that only one caller can win (`signup_disabled`, which the callback shows as `signup-closed`,
     otherwise); the sign-in by link is let to mail a newcomer's address only while a passport for it
     lives, the answer the same for every other address. One hour, once; **at most twenty live per link**,
     counted under a lock on the link's row; read against the link again at every use, so revoking,
     expiring or deleting the link's workspace takes its unspent passports with it. A passport authorizes only
     account creation. D-279 also observes a valid passport during an existing account’s explicit
     invitation sign-in to attest a private recipient receipt; it never changes sign-in authorization. Open servers need none; the setup's
     administrator, made outside a request, and anyone already signed up, are not asked for one. Erasure
     deletes an address's passports by the digest it read before the tombstone, and the daily sweep
     (`sweep:email-sign-ins`) a day past an hour or a use. The cookie is not cleared by the sign-up: spent,
     it opens nothing.
6. **The `.env` boundary.** What the process needs before it can serve stays in the environment:
   `DATABASE_URL`, the encryption key and the storage. What a person can set in the wizard — the
   GitHub client id and secret, mail (SMTP address and sender), who may sign up and
   `WORKSPACE_CREATORS` — moves to `server_settings`, the secrets encrypted with the existing
   encryption key and never returned (a read says `set: true`). On the **first start** of a server with
   those values in the environment they are imported **once**; after that the database is the only
   home, and a changed variable does nothing — `CONFIG.md` says so.
   *Amended 2026-10-22, as built (`modules/setup/settings.ts`):*
   - **The server's address stays in the environment.** `APP_URL` fixes the cookies' `__Host-` name,
     the origin checks and the library's base URL and trusted origins when each is built, so an address
     edited at run time would be a rewrite of all of them; the wizard's address step shows `APP_URL`
     and the callback GitHub needs (`APP_URL/auth/callback/github`), warns when the browser's own origin
     differs, and says that changing it is a deployment setting.
   - **Where GitHub is stays in the environment too**: `GITHUB_URL` and `GITHUB_API_URL`, github.com
     and its API by default, are a deployment's shape (an Enterprise Server, a stand-in on the same
     machine), not a choice in the browser. `https://`, or `http://` to the loopback alone; the
     library's own option names the authorize address, and the token, user and address calls are
     Purlay's already.
   - **Each secret is sealed bound to its column's name**, so one copied into the other column does
     not open there. *Amended 2026-10-22 (zero-env boot):* one that does not open — `ENCRYPTION_KEY`
     rotated — no longer stops the start: the server starts **in setup mode with that secret read as
     unset**, records which (`needsReentry`: `github`, `smtp`) in its runtime state for the wizard and the
     Administration page to say *this secret needs to be entered again* (**both arrive with their own
     changes; nothing exposes it over HTTP yet**, so until then an installed server whose only way in was
     the broken method is recovered by putting the old key back or by `CONFIG.md`'s SQL, not in the
     browser — setup being closed once a user exists). A truncated or corrupt ciphertext is `SealBroken`
     too (`platform/crypto.ts`: *altered*), and is treated as a rotated key. The server says in one `warn` line
     which setting and where `CONFIG.md` explains it, never a value. **Nothing is deleted or rewritten**:
     the unreadable ciphertext stays in the row until the operator saves a new value over it. A row that
     fails to decode for any other reason, or a database that fails, still stops the start. A response carries `settingsView` only: a secret as `{ set }`, the relay's
     address as its host alone — its user can be a relay's token.
   - **An SMTP address is parsed before it is kept**, as the transport will parse it
     (`platform/smtp-address.ts`), by the configuration and by the settings alike: one with an
     unescaped `#`, `/` or `?`, a broken escape, half the credentials or no host would be imported once
     and then stop every start, so it is refused before anything is written. The recovery after a
     rotated key clears the secrets **and** `imported_from_env_at`, so the next start imports again
     (`CONFIG.md`, run as written by a test).
   - **The import is one transaction** that makes the row or waits on the one another starting process
     is making, and reads it locked: two processes at once import once (measured, twenty rounds, half
     of them over a row a crashed start left unimported). A variable still set afterwards is named,
     never quoted, in one line at each start.
   - **The order of a start** keeps D-93's: listen, migrate (or, without `MIGRATE_ON_START`, wait for
     the migrations, polled), then import and read the settings and build the library and the relay
     from them (`runtimeServicesFrom`), then the library's schema check. Until the settings are read a
     request that needs the library is answered `503 DATABASE_UNAVAILABLE` — a busy server, which a
     client retries — and readiness says why. Who may make a workspace is read from the row on each
     request that asks, so it needs no rebuild.
   - **A fresh server starts with no GitHub and no mail variable at all** (Ruling R38, built as the zero-env
     boot): only the database, `ENCRYPTION_KEY`, `APP_URL` and the storage are required. `GITHUB_CLIENT_ID`
     and `GITHUB_CLIENT_SECRET` are optional seeds, **both or neither** (one without the other refuses the
     start, naming both), and empty is unset, as for every optional variable. The first import then writes
     a row **without** a GitHub app, and the wizard fills it in. With no GitHub app the library is built
     **without the provider**, and without the magic-link plugin where there is no relay: `/auth/github`
     and the library's own start of a social sign-in answer `404 ROUTE_NOT_FOUND` (the route does not exist
     until GitHub is connected; the library throws for a provider it lacks, and a 500 for a person who
     typed an address would be the wrong answer), a callback that arrives anyway is sent to the sign-in
     screen as `expired`, and `GET /api/auth/methods` says `{ github: false, email: false }`, which the
     sign-in screen reads as *this server is not set up yet*. The setup code is written to the log as it
     is for any server nobody uses (§4).
7. **Tables.** One migration adds `users.email_verified` (`BOOLEAN NOT NULL DEFAULT FALSE`),
   `accounts`, `verifications`, `rate_limits` (`key` unique, `count`, `last_request` as `BIGINT`);
   another adds `server_settings` (0049): one row of typed columns, held to one by its key — who may
   sign up (`sign_up`), the GitHub app (`github_client_id`, `github_client_secret_encrypted`), the
   relay (`smtp_url_encrypted`, `mail_from`, `smtp_allow_plaintext`), who may make a workspace
   (`workspace_creators`, `workspace_creator_logins`), and `setup_completed_at` and
   `imported_from_env_at`; typed columns rather than key/value rows, so each setting has a type, a
   default and a check in the database. The setup code's hash, the claim and the step reached have a table
   of their own (`setup_state`, 0050, one row; 0052 adds when each way in was saved after a try that
   worked), and so does the administrator's address check
   (`admin_email_verification`, 0051, one row: a digest, its account, its issue). Which migration holds which, and their DDL, belong to the migrations and then to
   `SCHEMA.md`, which a test binds to them; this record does not copy them (§6.1). One more
   (0055) is for an install from before the library, and was found by rehearsing that upgrade: it writes
   the `accounts` row the library's GitHub sign-in finds a person by for each user who has a `github_id`
   and none (without it that person is refused, `email-taken`, at the sign-in they used all along), and
   sets `email_verified` for the people who existed when 0047 ran — each proved an address then, by
   GitHub's primary verified one or a spent link — so that a sign-in link is still sent to them and an
   invitation can be accepted. It stores no token, and leaves an account made since, and an erased
   one, as they are.
8. **No data is carried over.** There is no real server data yet, so the change writes no migration of
   people's rows: development databases are rebuilt. If the owner says a server with real data exists,
   this changes and a tested move and its reverse are added first.
9. **Where the owner decided and where the builder did.**

| Decision | Whose |
|---|---|
| Better Auth, the newest stable version, plugins where they fit; read the current documentation at each step | Owner |
| Setup in the browser, a wizard with its seven steps and error guidance; *Finish* needs GitHub or email connected | Owner |
| Sign-up from the site, as Slack does; sign-in by GitHub or an email link; invitations by email | Owner; **the form of the last is the builder's**: the bearer link sent by mail, no role, no address binding (§5) |
| The administrator sets a password; everyone else signs in by link or GitHub | Owner |
| Motion between steps, switched off by *reduce motion*; the prototype is the visual reference | Owner |
| Invite-only as the default, and one choice in setup | Builder |
| A one-time setup code in the log, `/setup` closed once a user exists | Builder |
| Settings in the database, secrets encrypted, an instance built from them and swapped | Builder (the swap measured, Q5) |
| `/invite#<id>` kept, seven days | Builder |
| No migration of data | Builder (an assumption; the owner says if wrong) |
| Owner / admin / member roles and D-111 kept | Builder (kept by not using the plugin, Q4) |
| The role selector and per-address binding of invitations dropped | Builder; the owner is told |
| Who may make a workspace from the same source as `WORKSPACE_CREATORS` | Builder |
| The delivery in three parts: the record, the Better Auth core, the wizard and sign-up | Builder |
| Two kinds of administrator: the server's and a workspace's, given separately | Builder |
| Restarting the process to apply settings, if a swap were impossible | Builder; **not needed**, Q5 passed |
| Linking rules: one verified address, primary and verified GitHub address only, invitation by verified address | Builder, to be reviewed for security |
| Without mail: email controls hidden, finish needs a channel the administrator used | Builder |
| `/setup` closed on a server with users; first-start import once | Builder |
| The wizard's screens, copy and errors taken from the prototypes | Builder, from the owner's reference |

**Two details settled.** The server administrator is a column, `users.is_server_admin BOOLEAN NOT NULL
DEFAULT FALSE`, added by the migration that adds `email_verified`; the Admin plugin is **not installed**,
since it adds `role`, `banned`, `impersonatedBy` and more that creating the first administrator did not
need (Q8). The callback GitHub is given is the library's own, `/auth/callback/github`, computed from the
server address, and the wizard shows exactly that address, so nothing is hard-coded; no OAuth app is
registered before launch, so the path the product used to show (`/auth/github/callback`) is simply
replaced.

**Rejected.**
- *The Organization plugin in place of the `workspaces` module* — Q4 above.
- *Sessions as the library stores them, protected by the secret alone* — a dump plus the secret is every
  session; D-11 chose a hash for exactly this.
- *A second administrator route that leaves password sign-up open and closes it after setup* — a second
  instance in setup mode also works (Q8), but a door that is open until somebody remembers is the failure
  this is built against; the internal adapter has no window.
- *Restarting the process to apply a setting* — not needed once the holder swap passed.
- *Keeping the hand-written sign-in layer beside the library* — two places that decide who a person is.
- *Storing the secret in the settings so it can be changed in the browser* — it signs everybody out and
  puts the key beside the lock.

**Amends**, each pointed at where it is stated:
- **D-11**: sessions are the library's, hashed by our plugin; the opaque cookie in the database stays,
  and "GitHub OAuth only" is not true any more — an email link and, for the administrator and nobody
  else, a password.
- **D-31**: `better-auth` is now the library. OIDC is still not built; it waits for an operator who
  asks, and the library is what it would be added to.
- **D-115**: an invitation is accepted only by an account with a verified address; a person who has
  mail set up can send the link by email, and a send that fails says it was not sent and keeps the link
  to copy. The link, its token, its seven days and every other rule stand.
- **D-138**: signing in by link is the library's magic link, its token still in the fragment, still
  never in a path or a query, the hourly limit still five, now kept in the database. §2 and §3 are
  replaced: the same verified address is one account, and a GitHub sign-in is no longer refused
  because an email account has the address — but an account GitHub made still gets no link (§5). A new
  address gets a link only where sign-up is open (§5), and no account whose address is unverified gets
  one at all (§4.3).
- **D-155**: `WORKSPACE_CREATORS` is a server setting, imported once from the environment; the rule it
  states is unchanged.
- **D-176**: connecting GitHub to an account by a separate flow is replaced by linking on a verified
  address. An account whose GitHub address differs from its own cannot be joined to it; that was never
  built either, and is not now.

**Restated, not amended.** The guarantees of D-38, D-61, D-62 and D-121 — the callback is the one
origin's, state is verified or the callback is a CSRF endpoint, a failed sign-in comes back to the
sign-in screen with a reason — hold, and the code that replaces what carried them must show each one
tested. D-60's refusal of a revoked session on a socket, D-111 and the cross-tenant tests are untouched.

**Consequences.** Erasure (D-139, I-11) must clear `accounts` and `verifications` rows with the
rest of a person's data, and `DATA.md` lists them when their tables exist. `ENCRYPTION_KEY` now guards
settings as well as integration tokens, so rotating it invalidates both. Each later change names the
documentation page it was read from, and a difference between page and package is settled for the page.

*Amended 2026-10-23 (the letter again):* the administrator's letter can be sent again from the e-mail
step — `{ resend: true, locale }` on `/setup/smtp` — **through the relay already kept**, read on the
server (`readSettingsToBoot`), because the relay's address is never shown to a browser a second time
and a person whose first letter never came cannot be asked to type it, password and all. Refused
`out-of-order` before the mail step is reached and while no relay is kept. Considered and rejected: a
resend through the *serving* mailer, which would need failure reasons of its own — the probe already has
the closed set, the wizard already says each, and the same path gives the same words.

The link is one row, and a letter replaces it before it is known to have gone, so **any letter the relay
does not take puts the link it replaced back** — a resend, and equally a *new* relay tried and refused
(which, before, left the first letter's link dead). Three rules make that safe, each found by someone
who did not write it: it is put back **only while the row still holds the link this letter issued**
(`restoreAdminVerification` takes the digest; a later issue, or a link followed and spent, is not undone);
**letters go one at a time for a claim** (`oneLetterAtATime`: two at once each read the other's undelivered
link as the one to put back, and the delivered letter's link was lost — one process, since a setup is on
one node); and a put-back that itself fails is logged and says nothing more, so the relay's answer is
still the answer. *Accepted:* a try that ends at its deadline may have handed the letter over all the
same, and the earlier link is put back regardless — the common failure is a relay that is down, where the
earlier letter is the only one there is; the letter that arrives late then carries a link that no longer
opens, and another send makes it right. The same change makes the wizard say a sender that carries a name
— refused since the try was built — under its field, in its own words.

**Cost of reversing.** The library, its configuration and plugin, the migrations (dropping the new
tables and the column; `sessions` keeps its shape throughout), the wizard and `/setup`, and the
`server_settings` import. A reversal returns to the code D-11, D-38 and D-138 describe; the
`workspaces` module was never touched, which is what makes it possible.

**Amended 2026-11-26 (Better Auth 1.7.28).** The bullet above that says a failure of the library's read of
the rows it is about to delete "is swallowed while the delete goes ahead" describes 1.7.14 and no longer
holds. From 1.7.28 that failure stops the request before anything is deleted: the route answers 500, no
session is ended and no socket is closed. The whole-watch of the five session-ending routes stays, because
the hooks still see at most a hundred rows. `sockets.integration.test.ts` states the new contract: a socket closes if and only if its session
ended.
