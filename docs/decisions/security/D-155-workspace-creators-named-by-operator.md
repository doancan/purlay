# D-155. Who may make a workspace: the operator names them — #633

*Amended 2026-10-21 by D-179:* `WORKSPACE_CREATORS` is a server setting, imported once from the environment
at the first start and changed in the browser after; the rule below is unchanged.

**Context.** Signing in is open — an invited person has to be able to — and making a workspace asked
only for a session, so on an instance reachable from the internet anybody with a GitHub account could
sign in and make any number of workspaces, each with its own attachment quota (D-109 §5): disk without
a bound, for a stranger who found the address. Joining a workspace was already closed (an invitation,
D-115); making one was not. Decided in the owner's standing instruction to decide and proceed, and open
to their reversal.

**Decided.**

1. **The operator names who may: `WORKSPACE_CREATORS`** (`CONFIG.md`), GitHub logins, comma-separated
   and compared in any case, or `*` for anybody signed in — what a cloud or a demo wants. A login
   matches the username of an account signed in with GitHub, which is the login as GitHub last gave
   it; an account made by an email link (D-138) has no login, whatever its username spells, because
   its name came from an address anybody can own. A malformed value refuses to start. *Amended by
   D-169:* matched against the login itself, kept in a column of its own — a username is not one.
2. **Unset, nobody may but the first person to sign in, and only while the instance has no
   workspace** — the earliest living account, while `workspaces` is empty. The one-command install
   (D-144) still ends with its operator owning the first workspace, and a stranger who signs in after
   them cannot make a second. Two first workspaces asked for at once take turns on a lock, so only one
   is first.
3. **One check, in the transaction that makes the workspace** (`modules/workspaces/creators.ts`).
   Refused, it is `403 FORBIDDEN` — the endpoint is no resource of anybody's to hide — and nothing is
   made. Signing in is untouched.
4. **The client asks before it offers.** `GET /api/me` carries `mayCreateWorkspace`; a person with no
   workspace who may not is told to ask for an invitation, with no form, and the workspace menu's
   **Create workspace…** (D-124 §8) is offered only where it would be accepted. A refusal anyway — the
   first workspace made a moment ago — says the same above the form's button.
5. **Recorded as the create already is.** The audit trail is a workspace's (D-26), and a refusal has
   none to belong to; the request log carries the `403` and its code, as it does for every refusal.

**Rejected.** *An allowlist of who may sign in* (#633's option 2) — it closes the door earlier, but every
invitation would then need the operator to add the person too. *Leaving it open and bounding the
instance's storage instead* (option 3) — it bounds the disk, not the stranger's workspaces or what they
put in them. *Matching every account's username* — an email link would let anybody take an allowlisted
login that has not signed in yet. *The first workspace for whoever asks first* — the person who signed
in first is the one the install is for.

**Cost of reversing:** the variable, `creators.ts`, the field on `/api/me` (a client older than it reads
it as absent and offers the form, as before) and the screen; no migration.
