# D-121. A sign-in that did not finish comes back to the sign-in screen, with a reason

**Amends `API.md` §1 for one route.** `GET /auth/github/callback` threw into the one error hook like
every other route, so a failed sign-in answered the API's JSON envelope — and the callback is reached
only by a browser GitHub redirected, so that JSON was the page the person was left on, with no way
back (#490). The sign-in screen already read `?error`; nothing ever sent it.

**Decided.**

1. **The callback always answers a redirect.** Success goes to `APP_URL`, as before; every failure goes
   to `APP_URL/sign-in?error=<reason>` with the state cookie spent. *Every* failure, the rate limit and
   the unanticipated `INTERNAL` included: the branch sits in the error hook, keyed on the path, so
   nothing thrown while serving the callback can reach the browser as JSON. Every other route,
   `/auth/github` and both logouts included, keeps `API.md` §1's answer — they are not navigations a
   person lands on.
2. **The reason is one of a closed set, `SignInFailure` in `@purlay/types`** — `cancelled`, `expired`,
   `email-required`, `email-taken`, `github-unavailable`, `busy`, `failed` — with the writer of the
   address and its reader beside it, so the API and the client cannot spell the parameter or the set
   differently. Codes collapse into a reason where the person's next step is the same
   (`RATE_LIMITED` and `DATABASE_UNAVAILABLE` are both *wait, then retry*). **Nothing else enters the
   address**: no code, no message, nothing GitHub said. A URL is kept in history, copied into chat and
   written to logs; the cause goes to the server's log instead — `error` for the unanticipated, as
   every `INTERNAL` is, `warn` for GitHub's own failures and for a GitHub `error` other than a cancel.
3. **`expired` stays one reason for every way the state check fails.** The refusal was made uniform
   so a prober learns nothing about which half failed (D-62); a different sentence per half would
   undo that on the screen.
4. **A cancel is read before the state is checked.** `error=access_denied` carries no code, so nothing
   would be exchanged or signed in either way; a forged one shows the person a sentence telling them
   they cancelled. Checking the state first would turn every real cancel in a second tab into
   `expired`, which is the wrong instruction.
5. **GitHub's failures have a type, `GitHubUnavailableError`,** thrown by the client for an unreachable
   host, a refusing status, an answer that is not JSON and one that is not a usable identity. Before
   this they were plain `Error`s, indistinguishable from this server's defects, and became `INTERNAL`.
6. **Unknown reasons read as `failed`.** `?error=1` — the shape the client already read — or a
   hand-edited value still says the sign-in did not finish, rather than showing nothing.

**Rejected.**

- *Content negotiation on `Accept`* — JSON for a script, a redirect for a browser. Nothing but a
  browser follows GitHub's redirect here, so the JSON branch would serve no caller and keep a way to
  leave a person on a JSON page.
- *Carrying the error code in the address.* It ties the client's sentences to the server's taxonomy
  (`OAUTH_STATE_INVALID` is not something a person did) and would put a new code into URLs the moment
  one is added.
- *A reason per GitHub `error` value.* The others (`redirect_uri_mismatch`, `application_suspended`)
  are the operator's misconfiguration; the person can only retry, and the operator reads the log.

*Amended 2026-10-26:* a callback that carries a state another callback is still being answered for waits for it
(`oneAtATime`, `ingress/http/auth.ts`). The library reads a state and spends it in two steps, so two callbacks arriving
together (a double click, a retrying browser) could both read it and both go to GitHub with one code; the second was
refused as a spent code and told *GitHub is unavailable* when the first had just signed the person in. Queued, it reads a
state that is gone and is `expired`, as §3 says. Found as a failure of one run in about a hundred and fifty of the test
for it, on main's own pipeline.

**Cost of reversing:** the branch in `app.ts`'s error hook, `abandonSignIn` in `ingress/http/auth.ts`,
`packages/types/src/sign-in.ts`, seven catalogue lines per locale, and this paragraph. No stored data
depends on it.
