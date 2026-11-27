# D-38. GitHub identity: scopes, the email anchor, and every collision named

D-11 chose GitHub OAuth and made `email` the identity anchor, `NOT NULL UNIQUE`. No document ever
recorded which OAuth scopes are requested, and the default `/user` response omits the address of
any user who has not made it public — which is common among the developers this product is for.
As specified, the first such sign-in violates `NOT NULL` at runtime.

**Decided, with every collision given a defined answer rather than left to discovery.**

**Scopes: `read:user user:email`.** Nothing more. Repository access belongs to the workspace-level
integration token (D-23), not to a member's sign-in.

**Email.** Taken from `/user/emails`, the address that is both primary and verified. If the
account has none, sign-in is refused with `EMAIL_REQUIRED` and a message that says what to fix.
*Amended 2026-10-22 by D-179:* the library decides it (`unable_to_get_user_info`, `email_not_found`, `email_not_verified`), and the person is sent to the sign-in screen with `email-required`; the code `EMAIL_REQUIRED` is no longer in the contract, for nothing sent it.

*Rejected: making `email` nullable.* It is the anchor Phase 2's magic links resolve against
(D-11); an account with no anchor cannot be linked later without exactly the guessing D-5 refused.

**Email collision — same address, different `github_id`.** Refused with
`ACCOUNT_EMAIL_CONFLICT`. **Never linked silently.** D-5 already identified "same email via two
providers, therefore the same person" as a classic account-takeover surface and deferred magic
links partly because of it; the same reasoning applies between two GitHub accounts.

**Username.** `users.username` is GitHub's `login`, refreshed on every sign-in and display-only —
identity is `github_id`. GitHub allows an account to be renamed and the freed name to be taken by
someone else, so a refresh can collide with a live row. The incoming user is stored with a numeric
suffix and the collision is logged. Historical mentions are unaffected: `mentions` rows reference
a user id, resolved by the parser at write time (D-12).

**Erasure interaction, which neither D-22 nor D-27 covered.** An erased user keeps their
`github_id` under D-27 as written, so signing in again would upsert onto the erased row and
resurrect an account the person asked to have removed. **Erasure therefore also clears
`github_id`.** A later sign-in creates a fresh account, which is what the person asked for. The
column is nullable already (D-11) and `UNIQUE` permits multiple `NULL`s, so no schema change
follows. Invariant I-11 is extended accordingly.

**Reversibility:** the scopes and the email rule are free to change before the first sign-in and
expensive afterwards — a stored anchor that turns out to be wrong is a migration over live
accounts.
