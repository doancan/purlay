-- A source already holds workspace/user FK locks before capturing its recipients. Account erasure
-- locks sessions before workspaces; a second delivery-session FK would reverse that order.
-- Subscription deletion already cascades from sessions and cascades to push_deliveries. Keep the
-- captured session UUID as authority data, checked with generation and owner on every attempt.
ALTER TABLE push_deliveries DROP CONSTRAINT push_deliveries_session_id_fkey;

-- Both terminal diagnostic states are read together; expiry has its own indexed bounded batches.
DROP INDEX idx_push_intents_overflow;
CREATE INDEX idx_push_intents_unreported ON push_intents (id)
    WHERE state IN ('overflow', 'throttled') AND reported_at IS NULL;
