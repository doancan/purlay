-- 0021_invitations
--
-- A workspace's invitation links (D-115, closing O-2; `SCHEMA.md` §4.3).
--
--   * A link carries a random token, made as a session's is (`platform/tokens.ts`); only its SHA-256
--     is stored, hex, so a copy of the database opens no workspace. The token is shown once.
--   * A link lets anyone signed in who holds it join as `member`, until it expires or is revoked.
--     `revoked_at` is set, never cleared: a revoked link stays revoked, and the row stays as the
--     record of what was handed out.
--   * The workspace key is RESTRICT, as `audit_log`'s: workspaces are soft-deleted, and a hard purge
--     that would take the record of who was let in fails loudly instead.
--   * Every foreign-key column is indexed (D-89): `workspace_id` by the listing index.
--
-- Re-runnable: what it adds is dropped first.

DROP TABLE IF EXISTS workspace_invitations;

CREATE TABLE workspace_invitations (
    -- Application-supplied UUIDv7: the list is read newest first by keyset (D-8).
    id            UUID PRIMARY KEY,
    workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    token_hash    TEXT NOT NULL UNIQUE,
    -- NULL once the person who made it is erased (D-27); the link is the workspace's, not theirs.
    created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    revoked_at    TIMESTAMPTZ,

    CONSTRAINT workspace_invitations_id_is_uuidv7
        CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    CONSTRAINT workspace_invitations_token_is_a_digest CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT workspace_invitations_expire_after_made CHECK (expires_at > created_at)
);

-- The admin's list: one workspace's links, newest first.
CREATE INDEX idx_workspace_invitations_workspace ON workspace_invitations (workspace_id, id DESC);

CREATE INDEX idx_workspace_invitations_created_by ON workspace_invitations (created_by)
    WHERE created_by IS NOT NULL;
