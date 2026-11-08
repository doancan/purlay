-- The fact an entry of the server's trail is about (D-288 §11): an administrator who reads a dead fact's payload is on the trail, by the
-- fact's id and never by a word of it. NULL for every other entry. The column is nullable and has no key (a fact's row is swept, the
-- entry stays), so the migration writes nothing to existing rows and an older node ignores it.
ALTER TABLE server_audit_log ADD COLUMN target_fact_id uuid;
