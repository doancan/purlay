# D-42. The cloud stays shared-database multi-tenant

A paid cloud raises a question a single-team self-host never had to answer: does every customer get
their own database, their own schema, or a row-level tenant column in one database?

**Decided: unchanged — one database, `workspace_id` on every scoped table, isolation enforced by
`WorkspaceContext` and `ChannelContext` (D-21, D-34).**

**Why not a database per customer.** Every migration would fan out across every customer database,
and a migration that fails on customer 40 of 200 leaves the fleet in two different schema versions
— which is the failure mode that ends small teams. It also breaks D-3 outright: one identity across
workspaces is not expressible when the workspaces live in different databases.

**Why not a schema per customer.** The same migration fan-out, plus connection-pool pressure that
grows with the customer count, for isolation that a row filter already provides.

**The cost we are accepting, and it is the largest one in this document.** With shared tenancy the
blast radius of an isolation bug is *every customer at once*. That is precisely why D-21 makes the
cross-tenant test mandatory on every endpoint, why D-34 added the second axis, and why both are
enforced by types rather than by review. Those two rules stop being hygiene and become the thing
the business rests on.

**Noisy neighbours** are handled by limits that already exist — per-workspace storage quota (D-16)
and the connection rate limiter (D-25's `RateLimiter` seam) — extended with a per-workspace query
budget **only if a measurement shows one customer degrading another** (`CONTRIBUTING.md` §1.11).
