-- purlay: no-transaction
-- 0122_outbox_pending_age
--
-- How long a consumer's oldest pending fact has waited (`purlay_outbox_oldest_age_seconds`, `outbox-report.ts`): its pending
-- rows by when they were published, so the oldest is the first entry of the index and not the minimum of every row the consumer
-- has waiting. Measured on 400,000 pending rows over 40 workspaces: the oldest in 0.03 ms where the minimum read every row, and
-- with it the scrape of the three gauges in 95 ms on one core (36 ms with workers); the count that is left reads `idx_outbox_due`
-- without touching the table, in 30 ms. Inserting 100,000 rows took the same time with the index (3.7 s) as without (3.8 s).
--
-- CONCURRENTLY, and an INVALID leftover of a crashed build is dropped first.
--
-- Rollback: `DROP INDEX idx_outbox_pending_age`. The report then reads the minimum again, slower and the same.

DROP INDEX CONCURRENTLY IF EXISTS idx_outbox_pending_age;
CREATE INDEX CONCURRENTLY idx_outbox_pending_age
    ON outbox (consumer, created_at) WHERE state = 'pending';
