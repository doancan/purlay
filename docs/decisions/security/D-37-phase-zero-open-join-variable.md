# D-37. Phase 0 gets one explicit open-join variable, because its exit criterion is otherwise unreachable

**Superseded by D-115 (2026-10-12).** Invitation links replaced it; the variable is retired, and the
loader refuses it when set so an operator who left it in is told rather than ignored. What follows is
kept as the record of why Phase 0 had it.

Phase 0 ends when "two browser tabs, signed in as two different GitHub users, exchange a message
in real time". The Phase 0 endpoint list in `API.md` cannot produce that state: invitations are
Phase 1 (pending O-2), changing a member's role is Phase 1, and `POST /api/channels/:id/join`
already requires workspace membership. The second user has no way in. The phase was defined with
an exit criterion its own scope could not reach.

**Decided: one optional variable, `WORKSPACE_OPEN_JOIN_SLUG`.** When set, any authenticated user
who is not already a member of that workspace is joined as `member` on sign-in. Unset by default,
so an instance is closed unless the operator says otherwise. The boot log states plainly which
workspace is open, because an instance that quietly accepts anyone with a GitHub account is a
thing an operator must not discover by accident.

It is named by slug rather than being a boolean over "the first workspace", because "the first"
is an ordering that nobody chose and that changes as soon as there are two.

The join is audit-logged once `audit_log` exists (D-26, Phase 1).

**Rejected — pulling invitations into Phase 0.** Invitations are an unresolved question (O-2:
email versus shareable link versus GitHub-org auto-join), and answering it under schedule pressure
to unblock a walking skeleton is how a phase boundary stops meaning anything.

**Rejected — seeding the second user with a SQL fixture.** The exit criterion says *signed in as
two different GitHub users*. A fixture proves the message pipe and nothing about the OAuth path,
which is the other half of what Phase 0 exists to prove.

**Rejected — a development-only authentication bypass.** A flag that skips authentication is how
authentication CVEs are written, and it would still not exercise the real path.

**Reversibility:** free. One variable, one branch in the sign-in service. It survives into Phase 1
as a legitimate operator convenience or is deleted; either is a small change.

**Amended 2026-10-08, when it was built — two cases the paragraphs above did not decide.**

*A slug with no workspace behind it is not an error.* It is the expected state at first: the operator
signs in, then creates the workspace. Refusing sign-in would lock out the operator; refusing to boot
would make the variable impossible to set before the workspace exists. So sign-in proceeds and nobody
is joined. The cost is that the first person to create a workspace with that slug owns it, and the
boot notice says exactly that rather than leaving it to be discovered.

*Signing in never changes a membership that exists.* The join is an insert that does nothing on
conflict, not an upsert. An upsert would write `member` over the owner on their next sign-in, and with
one owner that breaks I-2 from an endpoint that has nothing to do with roles.

The boot notice is written directly to standard output, because the structured logger is #127; it
moves there with it.
