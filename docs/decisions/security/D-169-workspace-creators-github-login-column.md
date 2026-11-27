# D-169. `WORKSPACE_CREATORS` is matched against the GitHub login, kept in a column of its own — amends D-155 §1

**Context.** D-155 matched a listed login against the username of an account signed in with GitHub,
taking the username to be "the login as GitHub last gave it". It is not: a login another account
already holds here is stored with a `-N` (`availableUsername`), an email link names its account after
the address's local part (D-138), and a login shaped like an erased account's is given `user-` before
it (D-139 §5). A security review (2026-10-20) showed both directions: a stranger who signs in by email
as `alice@…` before GitHub's `alice` does makes her `alice-1`, and she is refused; a listed `bob-1`
lets in GitHub's `bob`, stored as `bob-1`. Decided under the owner's standing instruction to decide and
proceed, and open to their reversal.

**Decided.**

1. **`users.github_login`: the login as GitHub gave it at the latest sign-in** (migration 0045,
   `SCHEMA.md` §3.1). Written on every GitHub sign-in, as GitHub sent it — `TEXT`, never cut to the
   username's 39, since a cut login is another login. `NULL` for an account made by an email link —
   until it connects GitHub, which holds the login as a sign-in does (D-176).
2. **A sign-in takes its login from any other account that still holds it**, in any case. GitHub lets a
   login be given up and taken by somebody else; whoever signs in with it now is the one GitHub says it
   is, and an account renamed away keeps no claim until it signs in under its new one.
3. **`WORKSPACE_CREATORS` is compared with `github_login` alone** (`modules/workspaces/creators.ts`),
   in any case. The username plays no part.
4. **Existing accounts are filled where the username is the login unaltered** — a GitHub account whose
   username has no `-N` and no `user-` before it. Any other is `NULL` until its person next signs in:
   refused for a while rather than let in on a name that may be somebody else's.
5. **Personal, as `github_id` is.** Erasure clears it (I-11); an export omits it (D-140).

**Rejected.** *Not suffixing a GitHub login on collision, renaming the email account instead* — it
moves somebody's name under them and still leaves a username that only usually is a login. *Listing
GitHub ids instead of logins* — exact, but an operator knows logins, and the id is one GitHub API call
away for each, at configuration time. *A `UNIQUE` index on the login* — two sign-ins at once would each
take it from the other, and the loser's sign-in would fail; without it they share it a moment, which
only refuses neither more than it should. *Resolving the listed logins with GitHub at start-up* — a
network call to start, and still stale after a rename.

**Cost of reversing:** the column and its index (a migration dropping them), `holdLogin` in
`auth/identity.ts`, the one comparison in `creators.ts`, a line each in erasure and the export's
table.
