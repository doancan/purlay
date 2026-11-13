-- purlay: no-transaction
-- A retained epoch prevents a missing policy row from becoming implicit off (D-310).
SET lock_timeout = '10s';
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS access_policy_epoch BIGINT NOT NULL DEFAULT 0;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_access_policy_epoch_check' AND conrelid = 'workspaces'::regclass) THEN
        ALTER TABLE workspaces ADD CONSTRAINT workspaces_access_policy_epoch_check
            CHECK (access_policy_epoch >= 0) NOT VALID;
    END IF;
END $$;
ALTER TABLE workspaces VALIDATE CONSTRAINT workspaces_access_policy_epoch_check;

CREATE OR REPLACE FUNCTION retain_workspace_access_policy_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.access_policy_epoch < OLD.access_policy_epoch THEN
        RAISE EXCEPTION 'workspace access policy epoch cannot decrease' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS workspaces_access_policy_epoch ON workspaces;
CREATE TRIGGER workspaces_access_policy_epoch BEFORE UPDATE ON workspaces
    FOR EACH ROW EXECUTE FUNCTION retain_workspace_access_policy_epoch();

CREATE TABLE IF NOT EXISTS workspace_access_policies (
    workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    epoch BIGINT NOT NULL CHECK (epoch > 0),
    revision UUID NOT NULL DEFAULT gen_random_uuid(),
    mode TEXT NOT NULL CHECK (mode IN ('off', 'enforced')),
    sign_in TEXT NOT NULL CHECK (sign_in IN ('any', 'company')),
    allowed_connection_ids UUID[] NOT NULL DEFAULT '{}'
        CHECK (CASE WHEN array_ndims(allowed_connection_ids) > 1 THEN false
            ELSE cardinality(allowed_connection_ids) <= 16 AND array_position(allowed_connection_ids, NULL) IS NULL
                AND coalesce(array_lower(allowed_connection_ids, 1), 1) = 1 END),
    require_mfa BOOLEAN NOT NULL DEFAULT false,
    idle_minutes INTEGER CHECK (idle_minutes BETWEEN 5 AND 1440),
    max_age_hours INTEGER CHECK (max_age_hours BETWEEN 1 AND 720),
    mfa_max_age_minutes INTEGER CHECK (mfa_max_age_minutes BETWEEN 5 AND 1440),
    tested_at TIMESTAMPTZ,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workspace_access_policy_actor ON workspace_access_policies (updated_by) WHERE updated_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspace_access_policy_tests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    session_id UUID NOT NULL,
    user_id UUID NOT NULL,
    token_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    policy_revision UUID,
    policy_epoch BIGINT NOT NULL CHECK (policy_epoch >= 0),
    authentication_revision UUID NOT NULL,
    proposed_policy JSONB NOT NULL CHECK (jsonb_typeof(proposed_policy) = 'object' AND octet_length(proposed_policy::text) <= 4096),
    proposed_digest BYTEA NOT NULL CHECK (octet_length(proposed_digest) = 32),
    provider_revisions JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(provider_revisions) = 'object' AND octet_length(provider_revisions::text) <= 8192),
    recovery_revision UUID NOT NULL,
    factor_scope TEXT CHECK (factor_scope IN ('global', 'workspace')),
    factor_id UUID,
    factor_revision UUID,
    mfa_verified_at TIMESTAMPTZ,
    tested_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, session_id, user_id, id),
    FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_members(workspace_id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (session_id, user_id, authentication_revision) REFERENCES session_authentication_evidence(session_id, user_id, revision) ON DELETE CASCADE,
    CHECK ((policy_revision IS NULL) = (policy_epoch = 0)),
    CHECK ((factor_scope IS NULL AND factor_id IS NULL AND factor_revision IS NULL AND mfa_verified_at IS NULL)
        OR (factor_scope IS NOT NULL AND factor_id IS NOT NULL AND factor_revision IS NOT NULL AND mfa_verified_at IS NOT NULL)),
    CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS idx_workspace_policy_tests_member ON workspace_access_policy_tests (workspace_id, user_id, id);
CREATE INDEX IF NOT EXISTS idx_workspace_policy_tests_authentication ON workspace_access_policy_tests (session_id, user_id, authentication_revision);
CREATE INDEX IF NOT EXISTS idx_workspace_policy_tests_expiry ON workspace_access_policy_tests (expires_at, id);

CREATE TABLE IF NOT EXISTS workspace_session_assurances (
    workspace_id UUID NOT NULL,
    session_id UUID NOT NULL,
    user_id UUID NOT NULL,
    authentication_revision UUID NOT NULL,
    policy_revision UUID,
    policy_epoch BIGINT NOT NULL CHECK (policy_epoch >= 0),
    factor_scope TEXT CHECK (factor_scope IN ('global', 'workspace')),
    factor_id UUID,
    factor_revision UUID,
    mfa_verified_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    end_reason TEXT CHECK (end_reason IN ('expired', 'policy_changed', 'factor_revoked', 'source_revoked', 'member_removed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, session_id),
    FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_members(workspace_id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (session_id, user_id, authentication_revision) REFERENCES session_authentication_evidence(session_id, user_id, revision) ON DELETE CASCADE,
    CHECK ((policy_revision IS NULL) = (policy_epoch = 0)),
    CHECK ((factor_scope IS NULL AND factor_id IS NULL AND factor_revision IS NULL AND mfa_verified_at IS NULL)
        OR (factor_scope IS NOT NULL AND factor_id IS NOT NULL AND factor_revision IS NOT NULL AND mfa_verified_at IS NOT NULL)),
    CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
    CHECK (expires_at > last_used_at)
);
CREATE INDEX IF NOT EXISTS idx_workspace_assurance_member ON workspace_session_assurances (workspace_id, user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_workspace_assurance_authentication ON workspace_session_assurances (session_id, user_id, authentication_revision);
CREATE INDEX IF NOT EXISTS idx_workspace_assurance_expiry ON workspace_session_assurances (expires_at, workspace_id, session_id) WHERE ended_at IS NULL;

CREATE OR REPLACE FUNCTION retain_workspace_session_assurance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.workspace_id, NEW.session_id, NEW.user_id, NEW.authentication_revision, NEW.created_at)
        IS DISTINCT FROM ROW(OLD.workspace_id, OLD.session_id, OLD.user_id, OLD.authentication_revision, OLD.created_at) THEN
        RAISE EXCEPTION 'workspace assurance native identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.ended_at IS NOT NULL AND ROW(NEW.ended_at, NEW.end_reason) IS DISTINCT FROM ROW(OLD.ended_at, OLD.end_reason) THEN
        RAISE EXCEPTION 'ended workspace assurance cannot be revived' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS workspace_session_assurance_retained ON workspace_session_assurances;
CREATE TRIGGER workspace_session_assurance_retained BEFORE UPDATE ON workspace_session_assurances
    FOR EACH ROW EXECUTE FUNCTION retain_workspace_session_assurance();

RESET lock_timeout;
