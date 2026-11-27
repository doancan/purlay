# D-138. Signing in by email: a link that proves an address, and no account linked silently — #81

*Amended 2026-10-21 by D-179:* the link is Better Auth's magic link — its token still in the fragment, the
limit still five an hour, now counted in the database. §2 and §3 are replaced: one verified address is one
account, and a GitHub sign-in is no longer refused because an email account has the address.

**Context.** D-11 kept magic links for Phase 2 and D-38 fixed the anchor they resolve against:
`users.email`, the GitHub account's primary verified address, `NOT NULL UNIQUE`. D-5 named the risk —
"same email via two providers, therefore the same person" is a classic account takeover — and the issue
asks for the account-linking rules before any code. This is them, and the shape of everything around
them.

**Decision.**
1. **A link proves control of an address at the moment it is used, and nothing else.** Asking for one
   (`POST /auth/email`) answers `202` whatever the address: it never says whether an account exists.
2. **Email sign-in is for accounts made by email.** The first link used for an address no account has
   makes one, with no `github_id`; later links sign into it. An address that belongs to an account made
   with GitHub is sent a message saying it signs in with GitHub, and no link — the answer to the asker is
   the same `202`. *Rejected, and why it matters:* signing a GitHub account in by link would let whoever
   holds a mailbox the account no longer uses (the address is refreshed from GitHub only as D-38 says)
   into it; and nothing in this product refreshes the address on each sign-in yet.
3. **Nothing is linked silently — D-38 stands.** A GitHub sign-in whose verified address is an email
   account's is refused with `ACCOUNT_EMAIL_CONFLICT`, as two GitHub accounts on one address are. The
   pre-hijack this closes: somebody who once held the address — a shared mailbox, a former colleague, a
   recycled domain — makes the email account first and keeps its session, and the victim's GitHub
   sign-in would otherwise walk into it. Connecting the two deliberately, from a signed-in session, is
   not built here; it is its own decision when somebody needs it. *Amended 2026-10-20 by D-176:* it is
   built — from a session signed in as the email account, bound to that session; the refusal here stands
   for every unlinked sign-in, and now names that way through.
4. **The link carries its token in the fragment**: `APP_URL/sign-in/email#<token>`. A path is logged on
   every request (ARCHITECTURE §10), and mail scanners that open links do not send the fragment. The page
   shows the address the link was sent to — somebody who forwarded their own link cannot sign a victim
   into the sender's account unnoticed — and **Sign in** posts the token as JSON, under D-39's origin
   rule; only that use consumes it. The token is the platform's (32 random bytes, hex), kept only as its
   SHA-256, valid fifteen minutes, once. Asking again sends another; an earlier one stays valid until it
   expires, so nobody who knows the address can cancel its owner's link. An invitation the asking tab
   holds (D-115) rides after the token, `#<token>.<invitation>`, because the mail opens in a tab that has
   none; the page keeps it for that tab once the person is in, and joining is still their click. The
   field is a token's shape and nothing else, so no words of the asker's reach the mail. *Accepted:* an
   address typed wrong sends the invitation to a stranger, who could make an account and join — as
   pasting the invitation into the wrong chat would; and somebody can attach their own workspace's
   invitation to a link for another's address, which the invite screen names before any join.
5. **The account a link makes** has a username made from the address's local part, lower-cased, cut to
   what a mention can name, never one of the broadcast names (`here`, `channel`, `everyone`), and made
   unique as D-38's collision is; its display name is the same. An address with nothing to make a name
   of — a broadcast name, or punctuation — gets `user-` and six random hex digits, not `user-1` …
   `user-99`, which a hundred such addresses would use up for good. Two new addresses wanting one name
   at the same instant: one is made, the other fails loudly and its link is not spent, so pressing
   **Sign in** again makes it under the next name. *Amended 2026-10-21 by D-179:* the second is undone
   and tried once more by the server, so both are made, under the name and the next (D-179 §3). It is
   a member of nothing until invited.
6. **Delivery is SMTP**, the one transport every self-hoster has: `SMTP_URL` and `MAIL_FROM`, both or
   neither. Neither is email sign-in off — the server starts, `GET /api/auth/methods` says so, and asking
   is `503 EMAIL_SIGN_IN_UNAVAILABLE`, as push is off without its keys (D-126 §7). Every message carries a
   sign-in link, a bearer token, so mail to a relay past this machine goes only over TLS — `smtps://`, or
   STARTTLS required on `smtp://`, the usual submission on port 587 — unless `SMTP_ALLOW_PLAINTEXT` says
   the link is private, as the database's does (`docs/spikes/nodemailer.md`: the library refuses a
   server without STARTTLS when told to). The
   message is sent after the answer, so how long it takes says nothing about the address; the envelope
   names the one recipient. Whether the relay answers is said in the log as the server starts — not a
   refusal to start, since a relay down for a minute should not take the chat with it — and the shutdown
   waits two seconds for mail on its way, then says how many it left.
7. **Limits** (provisional, O-4): five links an hour for an address, twenty requests an hour from a
   client address, and the `auth` budget at the edge (*amended 2026-10-31 by D-231 §2:* five for an
   address from one client, twenty for it from every client); past them the answer is still `202` and nothing is
   sent, said in the log without the address. The count holds under requests at once — one per address
   at a time, behind a lock in the transaction (*amended 2026-10-21 by D-179:* each count is one
   statement on a counter in `rate_limits`, which takes its row, D-179 §3) — and an address is one
   mailbox written one way: ASCII
   atoms, `@`, dotted labels. A looser check let `x<a@example.com>` through, which a mail library
   delivers to `a@example.com` while it counts as an address of its own and matches no account.
8. **Never logged:** the address, the token, its hash, or the link — the list of ARCHITECTURE §10.
9. **Erasure** (D-27, #83) deletes the person's pending links as it rewrites their address.

**Rejected.** *A one-time code typed in* — phishable, and the link is what every mail client opens.
*Linking by address* — §2 and §3. *A provider's HTTP API* — locks a self-hoster in. *A hand-written SMTP
client* — STARTTLS, AUTH and dot-stuffing are where hand-written clients fail; the library is a spike
(CONTRIBUTING §6.7) before it is a dependency. *A page rendered by the server for the link* — D-50's one
client, and a token in a path.

**Cost of reversing:** the email sign-in table and routes; no account's identity changes shape, and
GitHub sign-in is untouched but for the refusal of §3, which it already makes between GitHub accounts.
