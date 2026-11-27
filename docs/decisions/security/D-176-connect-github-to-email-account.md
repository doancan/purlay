# D-176. Connecting GitHub to an account made by email, from a session signed in as it — answers D-138 §3

*Amended 2026-10-21 by D-179:* the separate connect flow is replaced by linking on one verified address;
D-179 §5 says when two accounts are one and what is never linked.
*Removed 2026-10-21 (D-179 §5):* `POST /api/me/github/connect`, the connect `state`, the outcome set
`ConnectGitHubOutcome` and its address `?github=<outcome>`, `GITHUB_ALREADY_CONNECTED`, the connect
module and the card's **Connect GitHub** button and footer are gone; §1–§5 and §7–§8 below describe what
was. What stays: `GET /api/me/sign-in`, now read only, is the card's source (the address, whether a link
signs in, the linked login); `github_connected_at` is written by the sign-in that links an account
(§6's rule that a linked account keeps its email link holds); `GITHUB_ACCOUNT_TAKEN` is still what a lost
race on the GitHub id's index is called. The sign-in screen's `email-taken` no longer sends anyone to
Settings: a local account has that address but has not verified it, so the sentence says to sign in by
the link sent to it first where the server sends mail (the sentence is chosen by whether the email form is on screen), or to ask an administrator to verify it where it does not.

**Context.** The owner's team signs in both ways: with GitHub, and by email link (D-138). D-138 §3 refuses
a GitHub sign-in whose verified address is an email account's — the pre-hijack it closes is real — and
left "connecting the two deliberately, from a signed-in session" to a decision of its own. Without it,
somebody who first came in by link can never use GitHub: their GitHub sign-in is `ACCOUNT_EMAIL_CONFLICT`
for good. Decided under the owner's standing instruction to decide and proceed, and open to their
reversal.

**Decided.**

1. **Only an account without a GitHub account connects one, only from a session signed in as it.**
   Settings → Sessions & account shows *How you sign in* — the address and whether a link to it signs in,
   and the GitHub login or **Connect GitHub** — and the button is `POST /api/me/github/connect`: a
   same-origin JSON `POST`, so D-39 §2 refuses it from any other site, and there is no `GET` a link or an
   image could make. It answers where to send the browser and sets the state cookie.
2. **The state is a sign-in's, bound to who asked.** The same `__Host-` cookie and ten minutes as D-62,
   the same HMAC, under a key derived for this purpose alone (`purlay:oauth-connect-state:v1`): the
   random state, its expiry, the user, the session and the workspace slug to come back to. A sign-in's
   cookie is never read as a connect's nor the other way round; one this server did not sign as a
   connect — forged, rewritten, another key — is a sign-in's failure (`expired`), and connects nothing.
3. **The callback finishes it only in the session that asked.** It is the one callback GitHub knows
   (D-61); the cookie says which handshake it is. Before GitHub is asked anything, the session signed in
   in this browser must be the very one named — not merely the same person — so a sign-out between the
   halves, a browser where somebody else has signed in since, or a cookie carried to another browser
   ends it (`session`), and the code is never spent. As the account is written the session is held
   live (`FOR SHARE`, D-85), the row locked, and one connect of a GitHub account runs at a time.
4. **Never merged, never moved.** A GitHub account another Purlay account signs in with is refused —
   `GITHUB_ACCOUNT_TAKEN`, `409`, with the unique index behind the check — and so is an account that
   has one already, `GITHUB_ALREADY_CONNECTED`. What is connected is the account GitHub vouches for with
   the code; the address plays no part, and nothing the browser sends names it.
5. **It changes the GitHub columns and the picture, nothing else.** `github_id`, `github_login` — taken
   from any other account still holding the login, as a sign-in takes it (D-169 §2) — `github_connected_at`
   (migration 0046), and `avatar_url`, since pictures are GitHub's (D-11) and an account made by email
   has none of its own to lose. The address, the username and the display name stay the person's; no
   session is issued. A line is logged at `info` with the user and the session. No audit row: the trail is
   a workspace's, and connecting touches none.
6. **After it, the account signs in both ways.** A GitHub sign-in finds it by `github_id` and refreshes
   the picture and the login only — never the names, which were never GitHub's (D-38's refresh is for an
   account GitHub made). Its email link still signs in: D-138 §2 keeps links from accounts **GitHub
   made**, which is what `github_connected_at` tells apart once both have a `github_id`.
7. **The way through is said where the refusal is.** D-138 §3's refusal stands for every unlinked
   GitHub sign-in — nothing is ever linked silently — and the sign-in screen's `email-taken` now says it:
   made with an email link, sign in by link and connect GitHub in Settings → Sessions & account; made with
   another GitHub account, sign in with that one.
8. **How it came out is said in words on the page it began on** — `APP_URL/w/<slug>/settings/account?
   github=<outcome>`, a closed set (`ConnectGitHubOutcome`, `API.md` §2), as D-121 does for a sign-in.
9. **Erasure and export.** Erasure clears `github_connected_at` with `github_id` and `github_login`
   (I-11); an export omits it as it omits them (D-140).

**Not built: disconnecting.** An account keeps every way in it has. An account made by email that
connected GitHub could lose GitHub and keep its link, but nothing needs that yet, and an account GitHub
made has no other way in — disconnecting it would lock its person out. When it is needed it is its own
decision: who may, from how recent a sign-in, and what of `WORKSPACE_CREATORS` (D-169) then.

**Rejected.** *Connecting by matching addresses* — D-138 §3, the takeover it closes. *Binding the state
to the user alone* — a connect would outlive the sign-out of the session that asked, and finish in any of
the person's browsers. *A second cookie for a connect* — two handshakes in one browser would each find
the other's state; one cookie, the latest started, is what a person who pressed twice means. *A `GET`
that starts it, as `/auth/github` does* — a sign-in begun by a third party signs nobody into anything
they did not hold, but a connect begun by one would start binding an identity to the victim's account.
*Taking GitHub's name and login as the account's names on connect* — they would move under the person,
silently. *Merging two accounts when the GitHub account is taken* — one person's messages, memberships
and audit rows becoming another's is not a sign-in decision. *An audit row in each workspace* — tells
every workspace's admins about a person's identity elsewhere, which an export already withholds.

**Cost of reversing:** `modules/auth/connect-github.ts`, the connect half of `state.ts`, the branch in
`ingress/http/auth.ts`'s callback, the two routes, the column (a migration dropping it) and its three
readers (`identity.ts`, `email-sign-in.ts`, erasure), the card on the account page, the two error codes
and the outcome set in `@purlay/types`. Accounts already connected keep their `github_id` and become
accounts that sign in with GitHub and — by D-138 §2 — no longer by link.
