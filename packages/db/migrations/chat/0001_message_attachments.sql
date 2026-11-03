-- chat/0001_message_attachments
--
-- Chat's half of moving an attachment's link to its message into chat (D-250, `MODULES.md` §10, step 8): which
-- message an attachment was sent with, in which channel, and in which workspace. It is chat's table because it
-- names chat's tables: the keys run from here to the core's `attachments` and to chat's `messages`, and never the
-- other way, so the core's table can be left alone when chat is off.
--
-- It keeps what the keys from `attachments` to `messages` kept (I-1): the composite keys make an attachment's
-- workspace and channel those of its message, and cascade with it. They are copied, not weakened.
--
-- Backfilled from the columns it replaces, which stay and are written as before until the release after this one
-- (see 0078). A message's file is found by `message_id`, a channel's by its own index in the order the list is read.

CREATE TABLE message_attachments (
    attachment_id uuid PRIMARY KEY,
    workspace_id  uuid NOT NULL,
    message_id    uuid NOT NULL,
    channel_id    uuid NOT NULL,
    CONSTRAINT message_attachments_attachment_fkey
        FOREIGN KEY (attachment_id, workspace_id)
        REFERENCES attachments (id, workspace_id) ON DELETE CASCADE,
    CONSTRAINT message_attachments_message_channel_fkey
        FOREIGN KEY (message_id, channel_id)
        REFERENCES messages (id, channel_id) ON DELETE CASCADE,
    CONSTRAINT message_attachments_message_workspace_fkey
        FOREIGN KEY (message_id, workspace_id)
        REFERENCES messages (id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX idx_message_attachments_message ON message_attachments (message_id);
CREATE INDEX idx_message_attachments_channel
    ON message_attachments (channel_id, message_id DESC, attachment_id DESC);

INSERT INTO message_attachments (attachment_id, workspace_id, message_id, channel_id)
SELECT id, workspace_id, message_id, channel_id
FROM attachments
WHERE message_id IS NOT NULL;
