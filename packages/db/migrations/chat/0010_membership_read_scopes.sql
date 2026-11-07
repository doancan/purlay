-- chat/0010_membership_read_scopes
-- Keep new private fields in chat's own table, leaving the legacy core's shape unchanged (D-250, D-275, D-282).
-- 0007–0009 have already been applied to development databases: preserve their known scopes before moving them.
CREATE TABLE channel_read_scopes (
    channel_id UUID NOT NULL,
    user_id UUID NOT NULL,
    unread_since TIMESTAMPTZ,
    unread_history_from UUID,
    thread_read_baseline_id UUID,
    PRIMARY KEY (channel_id, user_id),
    FOREIGN KEY (channel_id, user_id)
        REFERENCES channel_members(channel_id, user_id) ON DELETE CASCADE
);
CREATE INDEX idx_channel_read_scopes_user ON channel_read_scopes(user_id);

INSERT INTO channel_read_scopes(channel_id, user_id, unread_since, unread_history_from, thread_read_baseline_id)
SELECT channel_id, user_id, unread_since, unread_history_from, thread_read_baseline_id FROM channel_members
WHERE unread_since IS NOT NULL OR unread_history_from IS NOT NULL OR thread_read_baseline_id IS NOT NULL;

ALTER TABLE channel_members DROP COLUMN unread_since, DROP COLUMN unread_history_from, DROP COLUMN thread_read_baseline_id;
