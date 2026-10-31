-- purlay: no-transaction
-- 0065_account_suspension
--
-- The server's administrator can suspend an account and lift it (D-233): somebody who has left keeps their
-- history and their name in every conversation, and can no longer sign in.
--
--   * `users.suspended_at`: when the account was suspended; NULL is an account in use. A suspended account
--     starts no session and resolves none (`modules/auth/better-auth.ts`, `sessions.ts`); its sessions were
--     deleted in the transaction that set this. Not `deleted_at`: an erased account is gone for good and
--     tombstoned (D-139 §5); a suspended one is the same person, and lifting it changes nothing else.
--   * `server_audit_log.target_user_id`: whose account an entry is about, for the actions that have one
--     (`server.account_suspended`, `server.account_restored`). NULL for a setting, as every row before this.
--     `ON DELETE SET NULL` as the actor's: an erased account leaves the entry, unnamed.
--
-- No index on `suspended_at`: it is read by primary key with the rest of the user row. The trail is read by
-- the administrator rarely and newest first; `target_user_id` gets a partial index like the actor's, for the
-- foreign key's own `ON DELETE` scan.
--
-- Rollback: `ALTER TABLE users DROP COLUMN suspended_at` lifts every suspension at once — a decision, not a
-- cleanup — and `DROP INDEX CONCURRENTLY idx_server_audit_log_target` then `ALTER TABLE server_audit_log DROP
-- COLUMN target_user_id` forget whose entries were whose.
--
-- On tables with rows, outside the migrator's transaction (D-86): nullable columns without a default are
-- catalogue changes; the index is built CONCURRENTLY, dropped first since an interrupted build leaves an
-- invalid one. Each step can run again.

SET lock_timeout = '10s';

ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;

ALTER TABLE server_audit_log
    ADD COLUMN IF NOT EXISTS target_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

RESET lock_timeout;

DROP INDEX CONCURRENTLY IF EXISTS idx_server_audit_log_target;
CREATE INDEX CONCURRENTLY idx_server_audit_log_target ON server_audit_log (target_user_id)
    WHERE target_user_id IS NOT NULL;
