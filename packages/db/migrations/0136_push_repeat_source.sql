-- An urgent repeat has its own queue identity and uses the original notification for authorization.
ALTER TABLE push_intents ADD COLUMN repeat_notification_id UUID;
ALTER TABLE push_intents ADD CONSTRAINT push_intents_repeat_source CHECK (
    CASE
        WHEN source_kind = 'message' AND kind = 'urgent_repeat' THEN
            module = 'chat'
            AND repeat_notification_id IS NOT NULL
            AND repeat_notification_id <> source_id
            AND expires_at <= created_at + interval '2 minutes'
        ELSE repeat_notification_id IS NULL
    END
) NOT VALID;
