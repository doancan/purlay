-- purlay: no-transaction
-- 0074_incoming_webhooks
--
-- A channel's incoming webhooks (D-245): an address a CI job or a monitor posts a message to, under a name
-- of the hook's own, with no session.
--
--   * A hook is a channel's, in that channel's workspace (I-4): the composite key every channel row has, so
--     a hook cannot point across a tenant. It goes with its channel and its workspace.
--   * The secret is never stored: `secret_digest` is the SHA-256 of the 64 hex digits the address carries
--     (`platform/tokens.ts`), compared in constant time. A copy of the database posts nothing.
--   * `created_by` outlives its person as NULL: the hook is the channel's, and posts as nobody.
--   * Revoking a hook deletes its row: what it posted stays, under the name it posted with, which the
--     message's own metadata keeps.
--   * What a hook posts is a `system_event` with no sender (0032), whose metadata's kind is
--     `incoming_webhook`: `messages_event_known` is replaced to know it.
--
-- Rollback: `DROP TABLE incoming_webhooks` in a new migration stops every hook; the messages they posted
-- keep the kind, so the check must keep knowing it, and the reader with it.
--
-- Outside the migrator's transaction (D-86), as 0032: the new table has no rows; the check on `messages` is
-- added NOT VALID, which holds its lock only for the statement, and validated in the next, which scans
-- without blocking readers or writers. Each step can run again.

SET lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS incoming_webhooks (
    id            UUID PRIMARY KEY,
    workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    channel_id    UUID NOT NULL,
    name          VARCHAR(80) NOT NULL,
    secret_digest TEXT COLLATE "C" NOT NULL,
    created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL,
    last_used_at  TIMESTAMPTZ,

    CONSTRAINT incoming_webhooks_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
    CONSTRAINT incoming_webhooks_channel_workspace_fkey
        FOREIGN KEY (channel_id, workspace_id) REFERENCES channels (id, workspace_id)
        ON DELETE CASCADE
);

-- Every foreign key indexed (D-89); the channel's is also the list's, in its order.
CREATE INDEX IF NOT EXISTS idx_incoming_webhooks_channel ON incoming_webhooks (channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_incoming_webhooks_workspace ON incoming_webhooks (workspace_id);
CREATE INDEX IF NOT EXISTS idx_incoming_webhooks_created_by ON incoming_webhooks (created_by)
    WHERE created_by IS NOT NULL;

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_event_known;
ALTER TABLE messages ADD CONSTRAINT messages_event_known CHECK (
    message_type = 'text'
    OR metadata = '{}'::jsonb
    OR metadata ->> 'kind' IN ('push', 'pull_request', 'issues', 'release', 'incoming_webhook')
) NOT VALID;
ALTER TABLE messages VALIDATE CONSTRAINT messages_event_known;
