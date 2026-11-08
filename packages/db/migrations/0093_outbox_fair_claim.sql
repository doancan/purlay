-- purlay: no-transaction
-- 0093_outbox_fair_claim
--
-- What a claim walks (D-288 §11): a consumer's pending rows by workspace and then by when they are due, so that it can go from one
-- workspace to the next without reading the rows between, take each workspace's oldest due row, and then a few more of the chosen
-- workspaces' rows. It also answers what 0091 counted for the ceiling (a consumer's and a workspace's pending rows, up to the
-- ceiling) as well as 0091's index did, so 0091's goes: one index fewer to keep on a table that is mostly churn. Measured on a
-- million rows over 5,000 workspaces: the claim in 45 ms where a window over every due row took 370 ms, and the count of a
-- workspace at the ceiling in 0.8 ms.
--
-- Built before the old one is dropped, so a publish in a roll is never without an index; both CONCURRENTLY, and an INVALID leftover
-- of a crashed build is dropped first.
--
-- Rollback: `DROP INDEX idx_outbox_pending_by_workspace` and, if the ceiling's count must be fast meanwhile, 0091's index again.

DROP INDEX CONCURRENTLY IF EXISTS idx_outbox_pending_by_workspace;
CREATE INDEX CONCURRENTLY idx_outbox_pending_by_workspace
    ON outbox (consumer, workspace_id, next_attempt_at) WHERE state = 'pending';

DROP INDEX CONCURRENTLY IF EXISTS idx_outbox_pending_workspace;
