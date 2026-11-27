# D-355. A member who leaves is taken off their open issues, through the outbox — amends D-254

**Decided (the owner, 2026-11-27).** D-254 §3 said that "a member who leaves does not rewrite their issues": an issue kept the
assignee who left, as a name the client can no longer find. The owner was asked whether a member who leaves should instead have
their open issues unassigned, reversing that sentence, and chose it, through the outbox. The reason: an issue assigned to somebody
who can no longer see it is stuck. Nobody else reads it as theirs, the assignee cannot open it to hand it on, and nothing tells
anybody. It is also the first fact a product module consumes: the outbox (D-283 §2, D-288, D-353) was built and hardened without one.

**What changed.**

1. **The fact.** The core declares `core.member-left` in `CORE_FACTS` (`packages/types/src/facts.ts`): the person's id (`uuid`) and
   why (`left`, `removed`, `provisioning`), never who they were. The workspace is the fact's own. It is held `FACT_HOLD_DAYS_MAX` (14)
   days for a consumer no node runs, since what a consumer undoes is no less wrong late.
2. **Where it is published.** In the transaction that deletes the membership row, once for each row the delete returned and for no
   other, on every path that deletes one: leaving (`left`) and a removal by an owner or an admin (`removed`), both through `takeOut`
   in `modules/workspaces/members.ts`; and a projection of provisioned access that ends somebody's (`provisioning`): a SCIM
   deactivation or delete, a directory turned off (every person it admitted, at once), an offboarding from the console, a source,
   a role or a group that no longer admits them (`projectWorkspaceAccess`). Each path is handed a `MemberDepartures`
   (`modules/workspaces/member-departures.ts`) built from the application's one publishing context, and a path that is not handed
   one does not compile. A guest whose access expires keeps their membership row (the expiry is read where access is checked, and
   the row stays for a renewal), so an expiry publishes nothing; an expired guest cannot be given an issue (D-300). A workspace's
   purge publishes nothing: the workspace is gone with its issues. A fact refused for a full backlog or the workspace's rate
   (D-288 §10, #1306) ends the departure's transaction, so nobody leaves without the modules being told; the request is answered
   `429` and tried again.
3. **What issues does.** Issues lists `core.member-left` under `consumes` and handles it in `features/issues/facts.ts`. It reads
   the person's membership when the fact is delivered: one who may be given an issue again (they came back as a member, or as a
   guest let into issues) keeps what they hold and the delivery is `skipped`. Otherwise every **open** issue of that workspace
   assigned to them is unassigned, and each is written to the trail as a manual change is (`issue.assigned`, from the person to
   nobody) with no actor, since no person did it. A finished issue keeps its assignee, as the record of who did it. A second
   delivery finds nothing assigned and changes nothing. Where issues is not granted to the workspace, no row is written (D-353)
   and its issues stay as they were; where it is granted and not run by the node that publishes, the row is held for a node
   that runs it.
4. **A delivery says when it is.** A consumer is handed no clock, and D-46 forbids it reading one, so `DeliveredFact` carries
   `deliveredAt`, the drain's clock at the delivery: what issues writes as the issue's change and the trail's time.

What is left: a person who comes back and is given an issue in the moment between the consumer's read of their membership and its
update may lose that one assignment. It needs a rejoin and a new assignment within the same delivery, and is not guarded. And a
fact is published for each person, each with its own check of the backlog: one change that ends more memberships than
`OUTBOX_PENDING_MAX` (5000 unless set) at once, a directory of that many turned off, is refused whole until the operator raises it.
Publishing many facts in one statement would lift both, and waits for a workspace that size.

**Rejected.** *Unassigning in the core's transaction, by naming issues' table:* the core would import a module's table, which D-250
and D-271 forbid, and a server without issues would carry its rule. *A port the core calls in the removal's transaction:* issues may
be absent, stopped or slow, which is the case the outbox is for (D-283 §1), and the removal would wait on it. *Unassigning every
issue, finished ones too:* a finished issue's assignee is who did it, and the trail would lose it. *Skipping only when any membership
row exists:* a person back as a guest kept out of issues, or whose guest access has expired, cannot open the issue either, so
"may be given an issue" is the test (`isAssignable`, the same as an assignment's). *Dropping the fact for a consumer no node runs:*
an assignment stuck for as long as issues is off is the same fault, so it is held. *Catching a refused publish and letting the person
leave:* their issues would stay stuck, which is what this decision removes.

**Cost of reversing.** Remove `consumes` and the handler from issues, the declaration from `CORE_FACTS`, and the `departures` the
removal paths are handed; facts already delivered stay delivered, and the issues they unassigned stay unassigned.
