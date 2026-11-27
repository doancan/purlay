# D-266. A module's share of the pool is held at the connection, so no handler can take the pool without it — builds on D-87, D-250, D-254, D-260; amends D-260 §1

**Context.** D-260 made the share of the pool a manifest field, and the share it held was a wrapper on a transaction:
`createApp` built each module's boundary and the module's routes asked for it by id. Two things followed that nothing
caught. A read on the pool — and most of a module's reads are one — was never held, and a handler that took `database`
instead of the boundary, as any handler of a third module could, was held by nothing and said so to nobody
(`MODULES.md` §7 named it as what no test sees). And the read that decides whether a request may be made at all, the
membership, was outside the share only because one handler happened to put it before the boundary.

**Decision.**

1. **The share is a lease on every connection.** `createApp` leases the one database it hands every handler
   (`leasingExecutor`, `@purlay/db`: an executor on the same pool that asks a lease for each connection it takes and
   gives it back), the router notes whose request it is from the manifests' `routes` (`noteModule`), and
   `moduleConnections` (`platform/module-budget.ts`) answers the lease with the share of that module. Every statement of a
   module's route — a read as much as a write — is held, with nothing for a handler to ask for, and **a handler has no
   raw handle to take instead**: the application has no other. `module-seams.test.ts` holds `app.ts` to one use of the
   database it was given, and the doors and features to no pool of their own; a handler written to bypass the share would
   have to open one. This replaces `transactionsOf` and the `atomically` that issues' handlers were given.
2. **A request holds one slot however many connections it takes**, so a transaction that reads again on the pool cannot
   wait for itself in a share of two.
3. **The core stays outside every share.** A route the core owns is noted as nobody's; the sign-in library holds the
   unleased database; and the guards that decide whether a module's request may be made (`requireWorkspaceMembership`,
   `requireDeletionMembership`) are the core's whichever module asks (`inTheCore`), so a person who is not in a workspace
   holds no slot of a module they have no part in — what `features/issues/http/budget.integration.test.ts` held before and still holds.
4. **The share's time limit is the connection's.** The lease sets `statement_timeout` when the share's differs from the
   pool's, and only then, remembered for the connection so that one a share set to five seconds is not found so by
   the next holder; a transaction no longer sets it itself. A statement past it is cancelled by the database (`57014`) and
   answered `503 DATABASE_UNAVAILABLE` — the same code as a share in use, and now for every statement that runs past a
   limit, since the pool's own was `500 INTERNAL` — which a client retries.
5. **An exemption is a line a reviewer reads.** `budget` stays required (D-260); a module that declares `none` must also
   be named, with its reason, in `module-budgets.test.ts`. Chat was the one until it had a share (D-269).

**Rejected.** *A pool per module*: a partition wastes the connections a quiet module holds and a busy one needs, and
the sum of the pools is what counts against `max_connections`. *A type that hides the raw handle from a module's
handlers*: chat's services take `Executor` by the hundred, and a brand all of them had to be changed for was a larger
change than the one it guards against, where there is no other handle to brand. *Leasing in the composition root, when
the pool is made*: a test's `createApp` would then be unheld, and the budgets would be tested only on a started process.

**Cost of reversing.** The lease (`leasingExecutor`, `moduleConnections`), the note in the router and `inTheCore`;
`transactionsOf` returns. Nothing is stored.
