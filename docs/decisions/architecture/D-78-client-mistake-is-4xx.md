# D-78. A client's mistake is a 4xx whichever layer noticed it, and sign-in never fails on a long name

Three requests a client can make answered `500` although nothing on the server was wrong (#233): a
body that is not JSON (the framework's `PARSE`, which `refusalFor` did not know), two requests for
one workspace slug or channel name at once (the existence check races; the index is the authority
and nothing mapped its violation), and a sign-in whose GitHub login fills `VARCHAR(39)` and so cannot
take a `-1` suffix, or whose display name passes 128 characters (`22001`).

**Decided: `refusalFor` is the one place a failure becomes a response, and it now knows the
database's.** `PARSE` is `400 VALIDATION_FAILED` with no echo of the body. A unique violation maps
by **constraint name** to the code the contract already has — `workspaces_slug_key` to
`WORKSPACE_SLUG_TAKEN`, `idx_channels_unique_name` to `CHANNEL_NAME_TAKEN`, `users_email_key` to
`ACCOUNT_EMAIL_CONFLICT`, `messages_pkey` to `MESSAGE_ID_CONFLICT`. `22001` and `23514` are
`VALIDATION_FAILED`. Nothing the driver says — message, detail, column, value — is passed on. A
unique violation on an index not in the table stays `INTERNAL`: an unexpected collision is a defect
to be logged, not a mistake to be explained.

**Decided: sign-in truncates.** The login is shortened to leave room for its suffix, and the display
name to 128 characters, counted as the database counts them. The value belongs to GitHub, so the
only choices are to store a shortened one or to lock the person out of the product.

**Rejected — catching `23505` in each service.** Every new unique index would need the same
try/catch in a place that can forget it; the mapping table is one line per index and a test lists
them. **Rejected — mapping on SQLSTATE alone:** it cannot choose between `WORKSPACE_SLUG_TAKEN` and
`CHANNEL_NAME_TAKEN`. **Rejected — retrying the sign-in on a collision:** a name that is too long
does not become shorter on the second attempt. **Closed — a race between two first sign-ins of one GitHub account** (a double-clicked callback). It
violated `users_github_id_key` and answered `500`; the insert is now `ON CONFLICT (github_id) DO UPDATE`,
which refreshes the display fields and keeps the first username, and the email-owner check no longer
counts the same account as a stranger. Two simultaneous callbacks are two sessions and one user, tested
on a cloned database. Still `500`, deliberately: a soft-deleted account signing in again (its GitHub id is
never reused, D-38, and the contract has no code for it), and two *different* accounts racing for one
username (`users_username_key` maps to no code).

*Amended 2026-10-21 by D-179:* the property holds — two first sign-ins of one GitHub account at once
are two sessions and one user — and its mechanism is the sign-in library's now: the tab whose insert
lost is sent round `/auth/github` once more, and finds the account the other made (D-179 §3, Ruling
R28). The `ON CONFLICT` statement above is gone with the code it was in.

*Amended 2026-10-09 (#231): sign-in also removes control characters from the login, the display name and
the avatar address — PostgreSQL refuses a NUL in text, so GitHub sending one failed sign-in. A login left
empty becomes `user-<id>`; an email address with one is not an address and is never repaired, since
stripping would make it someone else's.*

**Reversibility:** free. A table and a function.
