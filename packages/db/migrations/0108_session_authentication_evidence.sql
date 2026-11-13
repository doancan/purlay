-- purlay: no-transaction
-- Native evidence is metadata over existing sessions, never another login authority (D-310).
-- Concurrent owner indexes avoid a write-blocking scan of live sessions. Every statement is resumable.
SET lock_timeout = '10s';

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = to_regclass('idx_sessions_native_owner') AND NOT indisvalid) THEN
        DROP INDEX idx_sessions_native_owner;
    END IF;
END $$;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_native_owner ON sessions (id, user_id);

-- A constant initial material revision is a metadata-only addition, not an authentication claim.
-- Factor identity is always part of a reference; inserts/material changes receive fresh revisions.
ALTER TABLE two_factors
    ADD COLUMN IF NOT EXISTS assurance_revision UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000000',
    ADD COLUMN IF NOT EXISTS last_assurance_counter BIGINT;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'two_factors_last_assurance_counter_check' AND conrelid = 'two_factors'::regclass) THEN
        ALTER TABLE two_factors ADD CONSTRAINT two_factors_last_assurance_counter_check
            CHECK (last_assurance_counter >= 0) NOT VALID;
    END IF;
END $$;
ALTER TABLE two_factors VALIDATE CONSTRAINT two_factors_last_assurance_counter_check;

CREATE OR REPLACE FUNCTION retain_native_factor_assurance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.assurance_revision := gen_random_uuid();
        NEW.last_assurance_counter := NULL;
    ELSE
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
            RAISE EXCEPTION 'native factor owner is immutable' USING ERRCODE = '23514';
        END IF;
        IF NEW.secret IS DISTINCT FROM OLD.secret OR NEW.backup_codes IS DISTINCT FROM OLD.backup_codes OR NEW.verified IS DISTINCT FROM OLD.verified THEN
            NEW.assurance_revision := gen_random_uuid();
        ELSE
            NEW.assurance_revision := OLD.assurance_revision;
        END IF;
        IF NEW.secret IS DISTINCT FROM OLD.secret THEN
            NEW.last_assurance_counter := NULL;
        ELSIF OLD.last_assurance_counter IS NOT NULL AND (NEW.last_assurance_counter IS NULL OR NEW.last_assurance_counter < OLD.last_assurance_counter) THEN
            RAISE EXCEPTION 'native assurance counter cannot decrease' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS two_factors_assurance ON two_factors;
CREATE TRIGGER two_factors_assurance BEFORE INSERT OR UPDATE ON two_factors
    FOR EACH ROW EXECUTE FUNCTION retain_native_factor_assurance();

CREATE TABLE IF NOT EXISTS session_authentication_evidence (
    session_id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    revision UUID NOT NULL DEFAULT gen_random_uuid(),
    method TEXT CHECK (method IN ('password', 'email_link', 'github', 'server_oidc', 'google', 'company_oidc')),
    authenticated_at TIMESTAMPTZ,
    company_workspace_id UUID,
    company_connection_id UUID,
    company_authentication_revision UUID,
    global_mfa_factor_id UUID,
    global_mfa_factor_revision UUID,
    global_mfa_method TEXT CHECK (global_mfa_method IN ('totp', 'recovery')),
    global_mfa_counter BIGINT CHECK (global_mfa_counter >= 0),
    global_mfa_verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, user_id, revision),
    FOREIGN KEY (session_id, user_id) REFERENCES sessions(id, user_id) ON DELETE CASCADE,
    CHECK ((method IS NULL) = (authenticated_at IS NULL)),
    CHECK ((method = 'company_oidc' AND company_workspace_id IS NOT NULL AND company_connection_id IS NOT NULL AND company_authentication_revision IS NOT NULL)
        OR (method IS DISTINCT FROM 'company_oidc' AND company_workspace_id IS NULL AND company_connection_id IS NULL AND company_authentication_revision IS NULL)),
    CHECK ((global_mfa_factor_id IS NULL AND global_mfa_factor_revision IS NULL AND global_mfa_method IS NULL AND global_mfa_counter IS NULL AND global_mfa_verified_at IS NULL)
        OR (global_mfa_factor_id IS NOT NULL AND global_mfa_factor_revision IS NOT NULL AND global_mfa_method IS NOT NULL AND global_mfa_verified_at IS NOT NULL
            AND ((global_mfa_method = 'totp' AND global_mfa_counter IS NOT NULL) OR (global_mfa_method = 'recovery' AND global_mfa_counter IS NULL))))
);
CREATE INDEX IF NOT EXISTS idx_authentication_evidence_user ON session_authentication_evidence (user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_authentication_evidence_company ON session_authentication_evidence (company_workspace_id, session_id) WHERE company_workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_authentication_evidence_factor ON session_authentication_evidence (global_mfa_factor_id, session_id) WHERE global_mfa_factor_id IS NOT NULL;

-- No provider/factor FK may erase classification or manufacture independent authority.
CREATE OR REPLACE FUNCTION retain_session_authentication_primary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.session_id, NEW.user_id, NEW.revision, NEW.method, NEW.authenticated_at, NEW.company_workspace_id, NEW.company_connection_id, NEW.company_authentication_revision, NEW.created_at)
        IS DISTINCT FROM ROW(OLD.session_id, OLD.user_id, OLD.revision, OLD.method, OLD.authenticated_at, OLD.company_workspace_id, OLD.company_connection_id, OLD.company_authentication_revision, OLD.created_at) THEN
        RAISE EXCEPTION 'native primary authentication evidence is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS session_authentication_primary ON session_authentication_evidence;
CREATE TRIGGER session_authentication_primary BEFORE UPDATE ON session_authentication_evidence
    FOR EACH ROW EXECUTE FUNCTION retain_session_authentication_primary();

ALTER TABLE native_authorizations ADD COLUMN IF NOT EXISTS authentication_source_session_id UUID;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'native_authorizations_authentication_source' AND conrelid = 'native_authorizations'::regclass) THEN
        ALTER TABLE native_authorizations ADD CONSTRAINT native_authorizations_authentication_source
            CHECK (authentication_source_session_id IS NULL OR company_workspace_id IS NULL OR authentication_source_session_id = company_source_session_id) NOT VALID;
    END IF;
END $$;
ALTER TABLE native_authorizations VALIDATE CONSTRAINT native_authorizations_authentication_source;

CREATE OR REPLACE FUNCTION retain_native_authentication_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.authentication_source_session_id IS DISTINCT FROM OLD.authentication_source_session_id THEN
        RAISE EXCEPTION 'native authorization authentication source is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS native_authorizations_authentication_source ON native_authorizations;
CREATE TRIGGER native_authorizations_authentication_source BEFORE UPDATE ON native_authorizations
    FOR EACH ROW EXECUTE FUNCTION retain_native_authentication_source();

RESET lock_timeout;
