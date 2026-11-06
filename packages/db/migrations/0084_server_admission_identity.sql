-- purlay: no-transaction
-- D-277: old accounts stay admitted; new-account policy defaults off. Constant defaults
-- are catalogue changes on PostgreSQL 18. Validate the user check apart from its short
-- definition lock, and build its index concurrently. Every step can run again (D-86).
SET lock_timeout = '10s';
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS allowed_email_domains text[] NOT NULL DEFAULT '{}';
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS require_account_approval boolean NOT NULL DEFAULT false;
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS display_name text CHECK (char_length(display_name) BETWEEN 1 AND 100);
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS support_url text CHECK (char_length(support_url) BETWEEN 1 AND 2048);
ALTER TABLE users ADD COLUMN IF NOT EXISTS admission_state text NOT NULL DEFAULT 'approved';
ALTER TABLE users ADD COLUMN IF NOT EXISTS admission_requires_verified_email boolean NOT NULL DEFAULT false;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_admission_state_known;
ALTER TABLE users ADD CONSTRAINT users_admission_state_known CHECK (admission_state IN ('approved', 'pending', 'denied')) NOT VALID;
ALTER TABLE users VALIDATE CONSTRAINT users_admission_state_known;
RESET lock_timeout;
DROP INDEX CONCURRENTLY IF EXISTS idx_users_admission_id;
CREATE INDEX CONCURRENTLY idx_users_admission_id ON users (admission_state, id DESC) WHERE deleted_at IS NULL;
