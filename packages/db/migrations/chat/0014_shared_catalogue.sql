-- Chat-owned derived index and durable progress; source/core columns remain unchanged (D-306).
CREATE TABLE message_shared_links (
    message_id UUID NOT NULL,
    link_key TEXT NOT NULL CHECK (link_key ~ '^[0-9a-f]{64}$'),
    workspace_id UUID NOT NULL,
    channel_id UUID NOT NULL,
    url TEXT NOT NULL CHECK (length(url) BETWEEN 1 AND 144016 AND url ~ '^https?://'),
    label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 16000),
    PRIMARY KEY (message_id, link_key),
    CONSTRAINT message_shared_links_channel_fkey FOREIGN KEY (message_id, channel_id)
        REFERENCES messages (id, channel_id) ON DELETE CASCADE,
    CONSTRAINT message_shared_links_workspace_fkey FOREIGN KEY (message_id, workspace_id)
        REFERENCES messages (id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX idx_message_shared_links_workspace ON message_shared_links (workspace_id, message_id DESC, link_key);
CREATE INDEX idx_message_shared_links_channel ON message_shared_links (channel_id, message_id DESC, link_key);

-- Pending source ids, not another copy of content. Writers and workers lock the source before this child.
CREATE TABLE message_shared_jobs (
    message_id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL,
    channel_id UUID NOT NULL,
    queued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT message_shared_jobs_channel_fkey FOREIGN KEY (message_id, channel_id)
        REFERENCES messages (id, channel_id) ON DELETE CASCADE,
    CONSTRAINT message_shared_jobs_workspace_fkey FOREIGN KEY (message_id, workspace_id)
        REFERENCES messages (id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX idx_message_shared_jobs_due ON message_shared_jobs (queued_at, message_id);
CREATE INDEX idx_message_shared_jobs_workspace ON message_shared_jobs (workspace_id);

-- A bounded singleton; the anchor may be deleted without losing the remaining historical interval.
CREATE TABLE shared_link_backfill (
    name TEXT PRIMARY KEY CHECK (name = 'links'),
    before_message_id UUID,
    complete BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO shared_link_backfill (name) VALUES ('links');
