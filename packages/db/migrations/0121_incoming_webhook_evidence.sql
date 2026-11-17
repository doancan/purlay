-- Request evidence for the legacy incoming table (D-312). Additive, with no backfill.
ALTER TABLE incoming_webhooks ADD COLUMN last_request_at TIMESTAMPTZ;
ALTER TABLE incoming_webhooks ADD COLUMN last_status INTEGER;
ALTER TABLE incoming_webhooks ADD COLUMN last_error TEXT;

