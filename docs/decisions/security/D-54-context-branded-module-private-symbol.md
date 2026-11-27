# D-54. A context is branded by a module-private symbol key, and asserting one is a lint error

D-21 and D-34 make isolation structural: a scoped repository takes a context the caller cannot
construct. `ARCHITECTURE.md` §7.3 originally wrote that brand the way it is usually written:

```typescript
readonly __brand: unique symbol;
```

It type-checks as a declaration and is **uninhabited**. In property position `unique symbol` names
a symbol no expression has — not a fresh `Symbol()`, not another `unique symbol` — so *nothing*,
including the guard, can produce a value of the type without an assertion. The mechanism would have
shipped with its escape hatch at the one place that must not have one, and every compile-time proof
that "a caller cannot forge a context" would have passed vacuously: nobody could make one at all.

The brand is a property keyed by a symbol its own module does not export:

```typescript
const tenancy: unique symbol = Symbol('WorkspaceContext');

export interface WorkspaceContext {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: UserRole;
  readonly [tenancy]: true;
}
```

Naming that key is the capability, and it stays in the file that verifies the membership row. A
plain object is rejected for a missing property; a `Symbol('WorkspaceContext')` declared elsewhere
is rejected as a different symbol. The type is inhabited exactly once, by the guard.

**Rejected: a class with a private field.** `class WorkspaceContext { #brand }` is nominal too, but
it turns a value that only ever travels between functions into a runtime construct — a constructor
to keep private, an instance that stops surviving serialization — and buys nothing the symbol key
does not.

**The hole that remains, and what closes it.** No type system refuses `{} as WorkspaceContext`.
Lint does: an assertion to any type whose name ends in `Context` is rejected repository-wide, with
**no exemption**, because the guard builds its context from a literal and never needs a cast —
there is no legitimate case to make room for. The rule matches by name so `ChannelContext` (D-34)
is covered before it is written, rather than on the day somebody remembers to extend a list.
`scripts/verify-enforcement.ts` proves the ban by writing a violation and requiring *that rule* to
be the one that rejects it.

**Amended 2026-10-09 (#183): the local object store is Garage, not MinIO.** The pinned MinIO images
can no longer be pulled — Docker Hub answers *repository does not exist* and quay.io has no manifest —
so `bun run db:up` failed on any machine without them cached, and CI had stopped starting them. Three
S3-compatible stores were run against the operations Phase 1 attachments need (`docs/spikes/object-storage.md`):
**Garage** and **RustFS** passed all of them, including a 25 MiB multipart write and a refused
anonymous read; SeaweedFS did not, on one attempt, and was not pursued.

**Decided: Garage.** 11 MB image and about 7 MB of memory at rest, against 106 MB and 120 MB for RustFS.
It is AGPL-3.0, the licence this project already ships under, and is maintained by a non-profit
association rather than a company that can change terms — the failure that created this issue was a
vendor ceasing to publish. The cost is a bootstrap: its image has no shell, so the cluster layout, the
bucket and the development key are created by `scripts/storage-init.sh` (idempotent), where MinIO
needed a compose sidecar.

**Rejected — RustFS.** The simplest to run (environment variables, one container), Apache-2.0 and
under active development, but its first stable release is three weeks old as of this entry. Worth
revisiting if Garage's bootstrap proves a burden to self-hosters; the application depends only on the
S3 API, so the switch is a compose change. **Rejected — SeaweedFS:** an unresolved signature error
with the configuration tried, which may be the configuration and not the software; a rejection resting
on one attempt is recorded as that.

**Reopened when** Garage misses an S3 operation the upload path needs, or stops publishing images.
