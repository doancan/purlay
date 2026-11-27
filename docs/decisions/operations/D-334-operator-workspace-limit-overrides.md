# D-334. Limits an operator can move for one workspace: one gate, an override table and a command (#1306)

**Context.** Three things bound a workspace: a storage quota that is a column of the workspace with its own command (D-173), the
pending-fact ceiling of one consumer (D-288 §10), and the issues' cap, a constant. Nothing bounded how fast one workspace publishes,
and nothing let an operator move a limit for one workspace without a release. A server that hosts several workspaces (the cloud, #116)
needs both.

**Decision.**
1. **One gate**, `platform/quotas.ts`: `limitFor(workspace, kind, default)` is the workspace's override, else the default the caller
   gives, else none; `passes(limit, held, adding)` is the arithmetic. Callers refuse in their own words, so a refusal reads as the
   feature's own; the gate says only the number. A module reaches it by two names only (`scripts/module-reach.mjs`).
2. **An override table**, `workspace_quotas (workspace_id, kind, limit_value, reason, changed_at)`, core, sparse, purged with the
   workspace, in no export. `kind` is a key (`deliveries_per_minute` of the core, `issues:rows` of a module), not a list, so a core
   table names no module (D-250 rule 5). 0 is a limit; a lowered limit deletes nothing.
3. **Two kinds first.** `deliveries_per_minute`: the rows a fact would write, counted over the last minute by `idx_outbox_workspace_recent`
   and capped at limit + 1, refused whole before anything is written, answered `429 RATE_LIMITED` with `Retry-After: 60`, for what a client makes the workspace publish in a request (what the system publishes in answer is bounded by the chain's depth and the backlog's ceiling, and a refusal there would dead-letter a fact whose cause was already answered); the default
   is `WORKSPACE_DELIVERIES_PER_MINUTE`, unset meaning none, so nothing changes where nobody sets it. `issues:rows`: the issues' cap
   with the same default as before (`ISSUES_PER_WORKSPACE_MAX`).
4. **The operator's command**, `bun run quota:set|clear|show`, with a required reason kept in the row, the same on a second run, on the
   workspace's trail as `quota.changed` (kind, from, to, never the reason, no actor). It is the model of `module:suspend`.
5. **Storage stays as it is** (D-173): its column, its command and its refusal are not moved; `quota:show` points at it.

**Rejected.** *A column on `workspaces` for each limit:* a new migration for every kind, and a core table naming a module's limit.
*A fixed table of kinds in a CHECK:* the same. *An HTTP route and a console page now:* a new server route needs its entries in the
route-ownership, core-claim and cross-tenant tables and a screen, and belongs with the cloud's console (#116); the command is what a
self-hosting operator has had for every such setting. *Counting distinct facts:* it cannot be bounded by an index range; the rows
are the work the outbox does. *Reading the override from a cache:* one primary-key read in the publisher's transaction costs less than
what a cache would cost to keep right across nodes; measured by `budget:latency`.

**Cost of reversing.** `DROP TABLE workspace_quotas` and `DROP INDEX idx_outbox_workspace_recent`; the gate falls back to the
defaults, which is what every workspace without a row already gets. The two commands, one config variable and one audit action go.
