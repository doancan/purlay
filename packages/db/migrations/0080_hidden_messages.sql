-- A personal deletion never changes the shared message or its attachments.
CREATE TABLE hidden_messages (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id UUID NOT NULL,
    channel_id UUID NOT NULL,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    hidden_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, message_id),
    FOREIGN KEY (message_id, channel_id) REFERENCES messages(id, channel_id) ON DELETE CASCADE,
    FOREIGN KEY (channel_id, workspace_id) REFERENCES channels(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX idx_hidden_messages_workspace ON hidden_messages(workspace_id);
CREATE INDEX idx_hidden_messages_message ON hidden_messages(message_id, channel_id);
CREATE INDEX idx_hidden_messages_channel ON hidden_messages(channel_id, workspace_id);
CREATE INDEX idx_hidden_messages_changes ON hidden_messages(user_id, channel_id, hidden_at, message_id);
