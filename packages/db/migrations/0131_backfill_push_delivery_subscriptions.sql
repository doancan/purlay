-- purlay: no-transaction
SET lock_timeout = '10s';

-- Walk the existing primary key. Writers since 0130 set the reference, so a restart only fills missing rows.
DO $$
DECLARE
    last_intent_id UUID := '00000000-0000-0000-0000-000000000000';
    last_subscription_id UUID := '00000000-0000-0000-0000-000000000000';
    last_generation UUID := '00000000-0000-0000-0000-000000000000';
BEGIN
    LOOP
        WITH batch AS (
            SELECT intent_id, subscription_id, generation
            FROM push_deliveries
            WHERE apns_session_id IS NULL AND web_subscription_id IS NULL
              AND (intent_id, subscription_id, generation) >= (last_intent_id, last_subscription_id, last_generation)
            ORDER BY intent_id, subscription_id, generation
            LIMIT 1000
            FOR NO KEY UPDATE
        ), filled AS (
            UPDATE push_deliveries AS delivery
            SET web_subscription_id = delivery.subscription_id
            FROM batch
            WHERE (delivery.intent_id, delivery.subscription_id, delivery.generation) =
                  (batch.intent_id, batch.subscription_id, batch.generation)
            RETURNING delivery.intent_id, delivery.subscription_id, delivery.generation
        )
        SELECT intent_id, subscription_id, generation INTO last_intent_id, last_subscription_id, last_generation
        FROM filled ORDER BY intent_id DESC, subscription_id DESC, generation DESC LIMIT 1;
        EXIT WHEN NOT FOUND;
        COMMIT;
    END LOOP;
END $$;

-- A failed concurrent build can leave an invalid index. Remove it before rebuilding on restart.
DROP INDEX CONCURRENTLY IF EXISTS idx_push_deliveries_apns_session;
CREATE INDEX CONCURRENTLY idx_push_deliveries_apns_session ON push_deliveries (apns_session_id)
    WHERE apns_session_id IS NOT NULL;
DROP INDEX CONCURRENTLY IF EXISTS idx_push_deliveries_web_subscription;
CREATE INDEX CONCURRENTLY idx_push_deliveries_web_subscription ON push_deliveries (web_subscription_id)
    WHERE web_subscription_id IS NOT NULL;

ALTER TABLE push_deliveries VALIDATE CONSTRAINT push_deliveries_apns_identity;
RESET lock_timeout;
