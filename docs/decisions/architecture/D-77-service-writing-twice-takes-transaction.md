# D-77. A service that writes twice takes a `Transaction`, and a test can see it fail

`createWorkspace` wrote the workspace and then its owner, `createChannel` the channel and then its
creator, and sign-in the account, the open-join membership and the session, each on the connection
pool. A failure between two writes left a workspace nobody could reach whose slug was taken for
good (I-2). The suite could not have said so: every integration test runs inside one rolled-back
transaction (D-46), which cleans up a half-finished request exactly as an atomic one would be
cleaned up (#232).

**Decided: the boundary is in the signature.** `Atomically` hands its body a `Transaction`, and
`createWorkspace` and `createChannel` accept nothing else, so passing the pool is a compile error
(`@ts-expect-error` in `modules/atomic-signature.test.ts` fails the build if it ever compiles).
`Transaction` differs from `Executor` in the literal type of `isTransaction`; narrowing is by
`instanceof`, not by reading that flag. The handlers open the boundary with `atomicallyOn`, which
still *joins* a transaction it is already inside, so the harness's outer transaction keeps working.
Sign-in's three writes share one boundary for the same reason; moving that orchestration out of the
handler is #245.

**Decided: committing behaviour is tested on a cloned database, by making the second write fail.**
`ingress/http/atomic-writes.integration.test.ts` clones the template database (D-46), installs a
trigger that refuses inserts into the second table, and asserts that the first row is gone and the
retry succeeds. The clone is dropped afterwards, so nothing is left behind and nothing depends on
the harness transaction.

**Rejected — a lint rule or a comment saying "pass a transaction".** The comment was already
there; the pool was passed anyway. **Rejected — each service opening its own transaction:** it
could not then join a caller's, which is the property D-46 needs. **Rejected — deleting rows in
`afterEach` on the shared database:** a crash between the test and its cleanup leaves rows a
developer's own database keeps; a dropped clone leaves nothing.

**Reversibility:** free. A type and a test.
