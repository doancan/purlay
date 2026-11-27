-- A draft registration predating scoped delivery is dormant until it registers again (D-342).
ALTER TABLE apns_subscriptions
    ADD COLUMN provider_scope TEXT;

-- Disabling Web Push cancels its side of an intent while APNs remains eligible.
ALTER TABLE push_intents
    ADD COLUMN web_canceled BOOLEAN NOT NULL DEFAULT false;

-- Keep the original Web foreign key in force during the backfill. These nullable columns do not rewrite the heap.
ALTER TABLE push_deliveries
    ADD COLUMN apns_session_id UUID,
    ADD COLUMN web_subscription_id UUID,
    ADD CONSTRAINT push_deliveries_apns_identity CHECK (
        CASE WHEN apns_session_id IS NULL THEN web_subscription_id IS NOT DISTINCT FROM subscription_id
             ELSE web_subscription_id IS NULL AND apns_session_id = subscription_id AND apns_session_id = session_id
        END
    ) NOT VALID;

-- Old Web Push writers keep their insert shape, and an old row updated before the backfill is filled too.
CREATE FUNCTION set_push_delivery_web_subscription() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    NEW.web_subscription_id := CASE WHEN NEW.apns_session_id IS NULL THEN NEW.subscription_id END;
    RETURN NEW;
END;
$$;

CREATE TRIGGER push_deliveries_set_web_subscription
    BEFORE INSERT OR UPDATE ON push_deliveries
    FOR EACH ROW EXECUTE FUNCTION set_push_delivery_web_subscription();
