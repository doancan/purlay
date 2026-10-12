-- 0022_audit_session
--
-- The trail names the session that acted, not a copy of where it came from (D-116, #397;
-- `SCHEMA.md` §9.1).
--
--   * `session_id` points at the session a request was made with; through it the address and the
--     agent of the sign-in are known (`sessions.ip_address`, `sessions.user_agent`) for as long as
--     the session is kept. When it is swept (D-87) the link becomes NULL: personal data is not
--     copied into a table nothing may delete from. Null for what no request did — a job, a script.
--   * `ip_address` and `user_agent`, never written, are dropped rather than left to look like data.
--   * Indexed where set, as every foreign key is (D-89).
--
-- Re-runnable: what it adds is dropped first; what it drops is dropped if there.

DROP INDEX IF EXISTS idx_audit_log_session;
ALTER TABLE audit_log DROP COLUMN IF EXISTS session_id;

ALTER TABLE audit_log ADD COLUMN session_id UUID REFERENCES sessions(id) ON DELETE SET NULL;
CREATE INDEX idx_audit_log_session ON audit_log (session_id) WHERE session_id IS NOT NULL;

ALTER TABLE audit_log DROP COLUMN IF EXISTS ip_address;
ALTER TABLE audit_log DROP COLUMN IF EXISTS user_agent;
