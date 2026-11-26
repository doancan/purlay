-- purlay: no-transaction
SET lock_timeout = '10s';

-- The provider indexes are usable before installing the cascade triggers. Restart after either add or validation.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conrelid = 'push_deliveries'::regclass
            AND conname = 'push_deliveries_apns_session_id_fkey'
    ) THEN
        ALTER TABLE push_deliveries ADD CONSTRAINT push_deliveries_apns_session_id_fkey
            FOREIGN KEY (apns_session_id) REFERENCES apns_subscriptions(session_id) ON DELETE CASCADE NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conrelid = 'push_deliveries'::regclass
            AND conname = 'push_deliveries_web_subscription_id_fkey'
    ) THEN
        ALTER TABLE push_deliveries ADD CONSTRAINT push_deliveries_web_subscription_id_fkey
            FOREIGN KEY (web_subscription_id) REFERENCES push_subscriptions(id) ON DELETE CASCADE NOT VALID;
    END IF;
END $$;

ALTER TABLE push_deliveries VALIDATE CONSTRAINT push_deliveries_apns_session_id_fkey;
ALTER TABLE push_deliveries VALIDATE CONSTRAINT push_deliveries_web_subscription_id_fkey;

-- Both provider keys now protect existing rows. The legacy key can be dropped in a short statement.
ALTER TABLE push_deliveries DROP CONSTRAINT IF EXISTS push_deliveries_subscription_id_fkey;
RESET lock_timeout;
