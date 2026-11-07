-- chat/0009_thread_read_baseline
-- Preserve the old feed's implicit thread reads when a legacy member first uses
-- independent thread receipts (D-282). Captured lazily under the membership lock,
-- before moving that feed position; no table-wide counter or receipt backfill.
-- New members start with no implicit thread reads. A UUID boundary, not a key to
-- a message whose retention should move somebody's private read position.
ALTER TABLE channel_members ADD COLUMN thread_read_baseline_id UUID;
