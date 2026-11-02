ALTER TYPE notification_type ADD VALUE 'reminder';

CREATE TABLE message_reminders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    channel_id UUID NOT NULL,
    message_id UUID NOT NULL,
    remind_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, message_id),
    FOREIGN KEY (channel_id, workspace_id) REFERENCES channels(id, workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (message_id, channel_id) REFERENCES messages(id, channel_id) ON DELETE CASCADE
);
CREATE INDEX idx_message_reminders_due ON message_reminders(remind_at, id);
CREATE INDEX idx_message_reminders_workspace ON message_reminders(workspace_id);
CREATE INDEX idx_message_reminders_channel ON message_reminders(channel_id, workspace_id);
CREATE INDEX idx_message_reminders_message ON message_reminders(message_id, channel_id);
