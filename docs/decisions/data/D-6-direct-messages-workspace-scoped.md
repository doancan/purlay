# D-6. Direct messages are workspace-scoped

A DM is a `channel` with `type = 'direct_message'` and a real `workspace_id`. It has no name;
membership defines it. The tenant guard (`where workspace_id = ...`) therefore holds with **no
exceptions**, which is what makes it enforceable.

**Fixes:** the `UNIQUE(workspace_id, name)` constraint that would have collided on the second
DM — `name` becomes nullable, and uniqueness is enforced by a partial index that applies only
to named channels. A separate unique index on the sorted member pair prevents duplicate DMs.
