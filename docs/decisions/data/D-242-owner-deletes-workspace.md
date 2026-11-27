# D-242. An owner deletes a workspace: gone at once, kept for a week, then erased — builds on D-9, D-26, D-27, D-140, D-141; closes #870

**Context.** Once made, a workspace could not be removed: the API reserved `DELETE /api/workspaces/:workspaceId` as
"not built", and `workspaces.deleted_at` (0003) was honoured by the tenancy guard but written by nothing. A team that
leaves, or a workspace made by mistake, stayed on the server with every message and file in it — personal data kept
with no purpose (D-27, D-28), and nobody able to say so but the operator with SQL. Deleting is the one act here whose
end is an erasure, so the questions are who, how surely, how reversibly, and what a crash half way leaves.

**Decision.**
1. **An owner asks, typing the workspace's name** (`POST /api/workspaces/:workspaceId/deletion`, `{ confirm }`). Not an
   admin: an admin manages the workspace and does not end it, as an owner's row is an owner's to change (§7.4). The
   name is compared exactly, both sides in one Unicode form (a keyboard composing `ğ` otherwise types a different
   string). No recent sign-in is required, unlike erasing an account (D-139 §5): the grace period below is the safety
   a fifteen-minute window would be, and it is reversible by every owner rather than by the one session.
2. **Gone at once, for everybody.** Asking sets `deleted_at`, which the guard has always refused — every route is
   `404`, every invitation link stops opening, a feed's delivery is refused, and the workspace leaves `memberships`.
   After the commit each channel's topic is sent `ACCESS_REVOKED` (one frame a channel, not a member and a channel)
   and each member `WORKSPACE_UPDATED`; sessions are untouched, since a person may be in other workspaces. *Not
   read-only*: a workspace in which people can still read but not write invites a week of "why can't I post", and
   keeps every route needing a second rule beside the guard; gone is the guard's one rule, already tested on every
   endpoint.
3. **A grace period of `WORKSPACE_DELETION_GRACE_DAYS`, seven days, any owner may take it back**
   (`DELETE /api/workspaces/:workspaceId/deletion`). A week covers an owner away for a few days and a deletion the
   other owners did not agree to, and is short enough that a team that meant it is not kept waiting for the erasure.
   The owners see it in `GET /api/me`'s `scheduledDeletions` — a bar in every workspace they still have, and on the
   front door when it was their last — the only place a deleted workspace appears. The two routes mint a
   `DeletionContext`, not a `WorkspaceContext` (`platform/tenancy.ts`): it admits a workspace whose deletion was asked
   for, and reaches nothing but the deletion. Asked twice is asked once (D-33): the same answer, nothing recorded;
   taken back twice the same.
4. **Then `purge:workspaces`, daily at 02:00**, claims every workspace past its grace period — `purge_started_at`,
   under the row's lock, which taking it back waits on too, so the two never both win and a late owner is told
   `409 WORKSPACE_DELETION_STARTED` — and empties it in bounded batches, each its own transaction: replies then roots
   (500 a batch, by `idx_messages_workspace_age`), their files through `dropFiles` and the deletion queue (D-141),
   uploads nobody sent, exports and their archives, channels (100 a batch, each taking its memberships, feeds,
   incidents and bookmarks), then every other table that names it and its memberships last. The last transaction
   sets `purged_at` only if no run already has, and writes the one line, so two runs or a run after a crash finish
   the work and record it once. A test reads the catalogue and fails on a table that refers to a workspace and is
   neither emptied nor a trail. Nothing is taken back or told on the way: nobody can reach the workspace, so no
   counter needs keeping and no lock order is shared with a writer.
5. **The row stays, a tombstone with its name and slug**: `audit_log` and `server_audit_log` refer to it and are never
   deleted from (I-9). This is not the cascade CONTRIBUTING §1.7 forbids: soft deletion still never cascades — the
   content goes by an explicit job, as D-9 allows ("only via an explicit operator-run purge"), after an owner asked
   and a week passed. The slug stays taken; a team that wants it back asks the operator.
6. **On both trails, never anything written.** The workspace's: `workspace.deletion_requested` with `purgeAt`, and
   `workspace.deletion_cancelled` — read by its owners and admins once it is back. The server's:
   `server.workspace_purged`, no actor (a job), `server_audit_log.target_workspace_id` naming it (0071).
7. **The dialog offers an export first**: a link to Data & retention, where the owner exports (D-140) and downloads
   before deleting. An export not downloaded is erased with the rest; one being made as the erasure starts finds its
   row gone and removes its own archive.

**Considered and rejected.** *`DELETE /api/workspaces/:workspaceId` with the name in the body* — a body on `DELETE` is
dropped by some proxies, and the deletion is a thing with a life of its own (asked, taken back), so it is a resource.
*Deleting at once* — one slip, or one owner against the others, and a team's history is gone with no way back.
*Read-only during the grace period* — see §2. *A server administrator's list of workspaces being deleted* — nothing
asked for it yet; the operator has the trail and the table. *Hard-deleting the workspace row* — the trails refer to
it, and an audit trail that loses what it describes is no trail. *Relying on `ON DELETE CASCADE` from the workspace*
— one statement over every row of a large workspace, with the files' keys lost.

**Cost of reversing.** The two routes and the job can go in one change; a workspace whose deletion was asked for then
simply stays gone (its `deleted_at` is 0003's), and taking one back would need SQL. What was erased is gone, which is
the point.
