# D-116. The trail names the session that acted, not a copy of where it came from — closes #397

D-26 gave `audit_log` an `ip_address` and a `user_agent` that nothing wrote, and listed sign-in,
sign-out and session revocation, which have no workspace for a `workspace_id NOT NULL` row. Decided in
the owner's standing instruction to decide and proceed, and open to their reversal.

**Decided:**
1. **A row names the session it was made with** (`session_id`, `ON DELETE SET NULL`). The session holds
   the sign-in's address and agent (`sessions.ip_address`, `sessions.user_agent`, D-81), so "from
   where" is answerable for as long as the session is kept; when it is swept (D-87) the link becomes
   NULL. Personal data is not copied into the one table nothing may delete from — the storage
   limitation a data controller owes (D-27) holds by construction instead of by an erasure job.
2. **The session comes from the request**, noted where it is proved — `requireSession` for HTTP, the
   upgrade for a socket frame — in the request's scope, and read by `recordAudit`. No service's
   signature changes, and a write no request made (a job, a script) names none.
3. **`ip_address` and `user_agent` are dropped** (migration `0022`): columns that are always empty look
   like data and are not.
4. **Signing in, signing out and revoking a session are the `sessions` table's record** — when, from
   where, until when, revoked when — for as long as the session is kept. They are not workspace events,
   and a trail of them per workspace would copy one sign-in into every workspace a person belongs to.

   *Amended 2026-10-21 by D-179:* ending a session deletes its row, as the sign-in library does, so
   "revoked when" is no longer kept, and a row's `session_id` becomes `NULL` the moment its session
   ends — in the same transaction, for an erasure's own trail rows too — not when it is swept.

**Rejected:**
- *Copying the address and agent onto each row.* An append-only table of addresses, kept forever, on a
  self-hosted product whose operators answer to GDPR and KVKK.
- *A nullable `workspace_id` for instance events.* A second kind of row that no workspace's admin can
  read, for a record the sessions table already keeps.
- *Passing the session through every service.* Nine signatures for one cross-cutting fact the request
  already carries.

**Accepted, stated:** after a session is swept, its rows say who acted and when, but no longer from
where. The sessions table keeps a session thirty days by default (`SESSION_TTL_DAYS`) plus the sweep's
grace — the window in which "from where" is a question worth asking. *Amended 2026-10-21 by D-179:*
a session's row now goes when the session ends, not when it is swept, so the link to it becomes `NULL`
at that moment (§4's amendment).
