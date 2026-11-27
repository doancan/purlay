# D-152. Anybody may leave a workspace

**Context.** A member could be removed by an owner or an admin, but could not leave: no endpoint, no
door. Somebody invited into the wrong workspace, or done with a team, had to ask an admin to take them
out — and the last owner, who must not leave a workspace with nobody to run it (I-2), had no rule
written for leaving at all. Found by the settings audit (2026-10-19).

**Decided.**

1. `DELETE /api/workspaces/:workspaceId/membership` — the caller leaves the workspace and every channel
   in it, by the same going as a removal (`takeOut` in `members.ts`), and their own sockets are told
   `ACCESS_REVOKED` for every channel they could see.
2. **Anybody's.** A member, an admin or an owner — except the **last** owner, who is `409 LAST_OWNER`
   and told to make somebody else an owner first. The role is read under the workspace's lock, as every
   change to members is, so two owners leaving at once cannot leave none.
3. **Recorded as `member.left`**, the person as both actor and target — the trail says who went of
   their own accord, apart from who was removed.
4. **Leaving is not being removed.** A link that was open before they left still lets them back in: the
   check that keeps a *removed* person out reads `member.removed` only (`invitations.ts`), because a
   removal is somebody else's decision and leaving was theirs.

**Rejected.** *`DELETE …/members/:userId` with one's own id* — that endpoint is an admin's and refuses
one's own row on purpose (nobody changes their own role there); one path with two sets of rules is the
confusion `members.ts` avoids. *Letting the last owner leave and deleting the workspace* — deleting a
workspace is unbuilt (D-124 ①) and is not something to do as a side effect of a person leaving.

**Cost of reversing:** one endpoint, its case in the cross-tenant table, an audit action, and a row
on Sessions & account.
