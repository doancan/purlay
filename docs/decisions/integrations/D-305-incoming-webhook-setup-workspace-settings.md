# D-305. Business systems set up an incoming channel webhook from workspace settings and test its real address — builds on D-245; amends D-245

**Context.** ERP and n8n integrations need a visible setup path in workspace settings, while incoming
hooks were reachable only through individual channel details. An isolated real SQL probe also showed
both an archived channel and a closed workspace still accepted a post after the first credential lookup.
The asynchronous rate-limit boundary separated that lookup from the transaction which wrote content.

**Decision.** Workspace owners/admins choose a readable named channel in Integrations and use the same
list/create/revoke component as channel details. Its page is owned by chat and loaded through the
settings manifest only after authorization, so core settings do not import a module's screens. Module
settings entries supply a screen loader; core pages retain their exhaustive static map. Reuse canonical channel discovery and its access scope;
direct messages are excluded. A generated secret address stays only in that setup's component state,
never a cache or storage, and disappears on channel/workspace change or Done. Existing public contracts,
the text-only payload, quiet delivery and the ten-hook cap remain D-245's.

The setup offers the JSON example to copy and a deliberate test POST through that exact generated path,
using the normal bounded HTTP client and IncomingWebhookAnswer validation. Say that a chat message was
accepted only after its receipt arrives; an uncertain response says to check the channel before another
send. Do not automatically retry or conflate a database receipt with an OS push. The test writes an
ordinary webhook message and refreshes last-used state. A GitHub connection failure does not disable it.

Inside the receiving transaction, lock the live channel for update before taking a live workspace
share lock, then update the hook and insert the message. Closure already committed returns the existing
indistinguishable 404 without changing last-used, counters or frames; a later closure waits for the post.
Use the clock after lock waits so guest history and message time agree. As guest admission does, the
channel update lock conflicts with a normal send's FK key-share before either can hold the other's
counter rows; the weaker no-key-update choice reproduced a mixed human/hook deadlock in real SQL.
Network and bucket waits remain outside those locks.

Measured feature growth is recorded beside the shell bound in `scripts/budget-web.ts` (D-196).
The total initial-JavaScript backstop and module source-map fences stay in force; no screen is made eager.

**Rejected.** A test which bypasses the secret address and falsely claims the external integration was
verified; storing raw credentials to recover an address; automatic retries of a non-idempotent test;
requiring GitHub credentials for generic business messages; rewriting existing migration files. Aggregate
delivery history, event-id duplicate protection, secret rotation and outgoing delivery remain separately
scoped improvements, not silently claimed by this setup path.

**Cost of reversing.** Remove the workspace entry and test affordance while retaining channel management
and the existing HTTP contract. Keep the final-write authority repair. No migration or stored format changes.
