# D-25. Capacity ceiling is multi-node; the system is built single-node until a measurement says otherwise

The earlier documents sized the product at "a 30-person team" and used that to reject Redis,
a broker and multiple nodes (D-7). That number was never written down as a number, which meant
D-7's own rule — *no new infrastructure without a measurement* — had no measurement to point at.

**Decided: a stated capacity ceiling, an explicit build target, and numeric triggers between
them.**

| | Build target (Phase 0–2) | Ceiling (Phase 3, demand-gated) |
|---|---|---|
| Concurrent sockets | 300 | 1 000+ |
| Peak message rate | 20 / s | 100 / s |
| Messages retained | 5 M | 50 M+ |
| Storage | 50 GB | 500 GB+ |
| Topology | one API process, one PostgreSQL, one bucket | N API nodes behind a sticky LB, shared event bus |

**What this changes today — and it is deliberately small.** Nothing multi-node is built. What
is built is the *absence of node-local correctness*: any state that would be silently wrong on
a second node goes behind an interface now, because retrofitting an interface is a refactor and
declaring one is a file.

- `EventBus` — already seamed (D-7). Unchanged.
- `PresenceRegistry` — **new seam.** Presence and typing are in-memory (D-7). On two nodes each
  node would see half the workspace and report the other half offline. Ephemeral data is allowed
  to be *lost*; it is not allowed to be *confidently wrong*.
- `RateLimiter` — **new seam.** An in-process limiter on N nodes grants N times the quota. The
  in-process implementation stays; the interface makes the shared implementation an adapter.
- Background jobs — moved out of the API process entirely (D-30), which is what makes them
  multi-node safe by construction rather than by coordination.

**Triggers. Any one of these opens Phase 3; none of them is a reason to act before it fires:**

1. Sustained concurrent sockets > 250 on a single node, or
2. Send-path p95 > 120 ms (`PRD.md` §5) with profiling attributing it to contention, or
3. Single-node RSS > 1 GB under normal load.

**Rejected: building for the ceiling now.** Redis, sticky sessions and a read replica in
Phase 0 would add three operational surfaces to a system that has not yet sent its first
message, and would contradict the tenet the product is built on (D-2, "subtract before adding").
A capacity target is a constraint on *design*, not a licence to build ahead of demand.

**Accepted costs, stated so they are not discovered later.** The single PostgreSQL primary is
the last thing to scale and is deliberately unaddressed. The trigram GIN index on `messages`
(D-10) is the first thing that will hurt: GIN maintenance is on the hot insert path and D-10
already records that cost. It is revisited at 10 M messages, not before.

**Reversibility:** cheap in this direction. The seams cost three interfaces. Removing them later
if the ceiling never arrives costs nothing — an interface with one implementation is not debt.

**Amended 2026-09-09.** The ceiling is no longer hypothetical for one of the two deployments.
The cloud (D-1) is multi-tenant and carries an uptime commitment, so it crosses into multi-node
territory by obligation rather than by measurement, and the three triggers above now describe
*when the self-hosted single node stops being enough* — which for a thirty-person team may be
never. **Two deployments, one codebase:** the cloud runs several nodes behind a sticky load
balancer with the shared adapters; a self-hoster runs one process with the in-process ones, and
nothing about that path gets harder because the cloud exists.
