-- Scheduled messages are durable personal drafts, delivered by the server even while clients are closed.
-- Delivery and the sent marker commit together. Row locks serialize editing, cancellation and delivery.
CREATE TYPE scheduled_message_state AS ENUM ('pending', 'sent', 'failed');

CREATE TABLE scheduled_messages (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    channel_id UUID NOT NULL,
    parent_id UUID,
    content TEXT NOT NULL,
    send_at TIMESTAMPTZ NOT NULL,
    state scheduled_message_state NOT NULL DEFAULT 'pending',
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    sent_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    failure_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (id, workspace_id),
    FOREIGN KEY (channel_id, workspace_id) REFERENCES channels(id, workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id, channel_id) REFERENCES messages(id, channel_id) ON DELETE CASCADE,
    CHECK ((state = 'failed') = (failure_code IS NOT NULL))
);

CREATE INDEX idx_scheduled_messages_due ON scheduled_messages(send_at, id) WHERE state = 'pending';
CREATE INDEX idx_scheduled_messages_owner ON scheduled_messages(user_id, workspace_id, state, send_at);
CREATE INDEX idx_scheduled_messages_workspace ON scheduled_messages(workspace_id);
CREATE INDEX idx_scheduled_messages_channel ON scheduled_messages(channel_id, workspace_id);
CREATE INDEX idx_scheduled_messages_parent ON scheduled_messages(parent_id, channel_id) WHERE parent_id IS NOT NULL;
CREATE INDEX idx_scheduled_messages_sent ON scheduled_messages(sent_message_id) WHERE sent_message_id IS NOT NULL;
CREATE INDEX idx_scheduled_messages_finished ON scheduled_messages(updated_at) WHERE state <> 'pending';

-- A direct column makes an orphan sweep recheck a reservation after waiting for a row lock.
-- The workspace composite key also prevents a reserved file from crossing tenants.
ALTER TABLE attachments ADD COLUMN scheduled_message_id UUID;
ALTER TABLE attachments ADD CONSTRAINT attachments_schedule_workspace_fkey
    FOREIGN KEY (scheduled_message_id, workspace_id) REFERENCES scheduled_messages(id, workspace_id)
    ON DELETE SET NULL (scheduled_message_id);
ALTER TABLE attachments ADD CONSTRAINT attachments_one_destination
    CHECK (message_id IS NULL OR scheduled_message_id IS NULL);
CREATE INDEX idx_attachments_schedule ON attachments(scheduled_message_id, workspace_id)
    WHERE scheduled_message_id IS NOT NULL;
