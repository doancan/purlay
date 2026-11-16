-- purlay: no-transaction
-- Bounded retention reads by the age it expires (D-312). Safe to resume after interruption.
SET lock_timeout = '10s';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_webhook_attempts_age ON webhook_delivery_attempts(attempted_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_webhook_deliveries_completed ON webhook_deliveries(completed_at) WHERE completed_at IS NOT NULL;
