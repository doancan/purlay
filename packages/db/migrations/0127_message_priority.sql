-- 0127_message_priority
-- How much a message asks of its recipient: normal, important or urgent. Only a direct message, or one that names
-- somebody, may be anything but normal; the service enforces that, since the column cannot see the channel's type.
-- The default is a constant, so the column is added without rewriting the table, and every earlier message is normal.
ALTER TABLE messages ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE messages ADD CONSTRAINT messages_priority_known
    CHECK (priority IN ('normal', 'important', 'urgent')) NOT VALID;
ALTER TABLE messages VALIDATE CONSTRAINT messages_priority_known;
