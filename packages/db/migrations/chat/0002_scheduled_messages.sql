-- chat/0002_scheduled_messages
--
-- Scheduled messages are durable personal drafts, delivered by the server even while clients are closed.
-- Delivery and the sent marker commit together. Row locks serialize editing, cancellation and delivery.
--
-- The files a draft will send are reserved in chat's own table, never by a column of the core's `attachments`
-- (D-250, `MODULES.md` §5: keys run from a module to the core). A reserved upload is claimed (`claimed_at`), so
-- the core neither sweeps it as an orphan nor lets it be sent or discarded twice. Whenever a reservation goes —
-- edited away, delivered, the draft cancelled, or the draft taken by a cascade from its channel or its parent —
-- the trigger below gives the claim back, and an upload nobody then sends is the orphan sweep's, as before.
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

-- One draft at most holds a file (the primary key); the composite keys keep a file and its draft in one workspace.
CREATE TABLE scheduled_message_attachments (
    attachment_id uuid PRIMARY KEY,
    workspace_id  uuid NOT NULL,
    scheduled_message_id uuid NOT NULL,
    CONSTRAINT scheduled_message_attachments_attachment_fkey
        FOREIGN KEY (attachment_id, workspace_id)
        REFERENCES attachments (id, workspace_id) ON DELETE CASCADE,
    CONSTRAINT scheduled_message_attachments_schedule_fkey
        FOREIGN KEY (scheduled_message_id, workspace_id)
        REFERENCES scheduled_messages (id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX idx_scheduled_message_attachments_schedule
    ON scheduled_message_attachments (scheduled_message_id, workspace_id);

-- A reservation that goes gives its claim back, however it goes: by a statement or by a cascade.
CREATE FUNCTION release_scheduled_attachment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE attachments SET claimed_at = NULL
    WHERE id = OLD.attachment_id
      AND NOT EXISTS (SELECT 1 FROM message_attachments m WHERE m.attachment_id = OLD.attachment_id);
    RETURN NULL;
END;
$$;

CREATE TRIGGER scheduled_message_attachments_release
    AFTER DELETE ON scheduled_message_attachments
    FOR EACH ROW EXECUTE FUNCTION release_scheduled_attachment();
