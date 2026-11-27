# D-111. What managing members means: who may touch whom, and what a removal takes

`ARCHITECTURE.md` §7.4 gives owners and admins "manage members and roles" and owners alone "transfer
ownership", and I-2 keeps the last owner. It did not say where one ends and the other begins, nor
what a removed member keeps. Served by #51; decided in the owner's standing instruction to decide
and proceed, and open to their reversal.

**Decided.**

1. **Making somebody an owner is transferring ownership**, so only an owner does it; and an owner's
   row — their role or their membership — is an owner's to change. An admin manages members and
   admins, themself included. A member manages nobody: `403 FORBIDDEN`, for what the caller is.
2. **Ownership moves by adding before taking**: an owner makes another owner, then may step down.
   A change that would leave none is `409 LAST_OWNER`, and every change takes the workspace row's
   lock and reads the roles — the caller's as well — under it, so two owners stepping down at once
   leave one: the second finds it is no longer an owner.
3. **A removed member loses the workspace's channels**, their channel memberships deleted with
   the workspace one, and their sockets are sent `ACCESS_REVOKED` for every channel they could see
   (D-85). Their messages stay, by their name (D-9, D-22).

**Rejected: an admin who may change owners.** It would let the second-highest role demote the
highest, which is a transfer of control under another name. **Rejected: keeping a removed member's
private channel memberships** for if they come back: a person removed from a team is not quietly
still in its private rooms, and coming back is joining again.
