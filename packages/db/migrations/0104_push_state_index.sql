-- purlay: no-transaction
-- D-307: state-led access serves live cancellation and terminal reporting. The partial ID-only
-- index duplicates the primary key. Drop-first makes an interrupted concurrent build restartable.
DROP INDEX CONCURRENTLY IF EXISTS idx_push_intents_state;
CREATE INDEX CONCURRENTLY idx_push_intents_state ON push_intents (state, id);
DROP INDEX CONCURRENTLY IF EXISTS idx_push_intents_unreported;
