# D-22. Workspace ownership lives in the membership row, not on the workspace

The earlier draft had `workspaces.owner_id ... ON DELETE RESTRICT`, which makes a user who owns
a workspace **permanently undeletable** — a legal problem the moment someone asks to have their
account removed, and an operational one when a founder leaves.

**Decided:** `owner_id` is removed. Ownership is `workspace_members.role = 'owner'`, which also
makes co-ownership and ownership transfer expressible instead of impossible. `created_by` is
kept purely for audit and is `ON DELETE SET NULL`.

**Related:** users are **soft-deleted** (`users.deleted_at`) so that authorship on historical
messages survives; `messages.sender_id` therefore stays `ON DELETE RESTRICT`. Anonymising a
departed user is a profile-level operation, not a row deletion.
