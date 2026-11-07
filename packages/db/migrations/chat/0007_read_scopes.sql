-- chat/0007_read_scopes
-- A join's history floor and independent thread receipts (#1193, D-282).
-- NULL keeps an existing or explicitly rewound membership's historical scope:
-- the old model did not distinguish a never-read join from a historical rewind,
-- so backfilling joined_at could silently discard a person's requested unread range.
-- New memberships write their injected join clock into both timestamps.
ALTER TABLE channel_members ADD COLUMN unread_since TIMESTAMPTZ;

-- One cursor per opened thread, not one receipt per message or per recipient.
-- The cursor deliberately has no key to its reply: retention may remove a read
-- reply while the root and the person's later position remain meaningful.
CREATE TABLE thread_reads (
    channel_id UUID NOT NULL,
    user_id UUID NOT NULL,
    root_id UUID NOT NULL,
    last_read_message_id UUID NOT NULL,
    read_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (channel_id, user_id, root_id),
    FOREIGN KEY (channel_id, user_id)
        REFERENCES channel_members(channel_id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (root_id, channel_id)
        REFERENCES messages(id, channel_id) ON DELETE CASCADE
);
CREATE INDEX idx_thread_reads_root ON thread_reads(root_id, channel_id);
CREATE INDEX idx_thread_reads_user ON thread_reads(user_id);
