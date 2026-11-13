-- Workspace factors are owned by native membership; company control never reaches global factors (D-310).
CREATE TABLE workspace_mfa_factors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    user_id UUID NOT NULL,
    revision UUID NOT NULL DEFAULT gen_random_uuid(),
    secret_encrypted BYTEA NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'verified', 'revoked')),
    pending_expires_at TIMESTAMPTZ,
    verified_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    last_accepted_counter BIGINT CHECK (last_accepted_counter >= 0),
    failed_verification_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_verification_count >= 0),
    locked_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, user_id, id),
    FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_members(workspace_id, user_id) ON DELETE CASCADE,
    CHECK ((state = 'pending' AND pending_expires_at IS NOT NULL AND verified_at IS NULL AND revoked_at IS NULL)
        OR (state = 'verified' AND verified_at IS NOT NULL AND revoked_at IS NULL)
        OR (state = 'revoked' AND revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX idx_workspace_mfa_pending ON workspace_mfa_factors (workspace_id, user_id) WHERE state = 'pending';
CREATE UNIQUE INDEX idx_workspace_mfa_verified ON workspace_mfa_factors (workspace_id, user_id) WHERE state = 'verified';
CREATE INDEX idx_workspace_mfa_pending_expiry ON workspace_mfa_factors (pending_expires_at, id) WHERE state = 'pending';
CREATE INDEX idx_workspace_mfa_user ON workspace_mfa_factors (user_id, id);

CREATE FUNCTION retain_workspace_mfa_factor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.id, NEW.workspace_id, NEW.user_id, NEW.secret_encrypted, NEW.created_at)
        IS DISTINCT FROM ROW(OLD.id, OLD.workspace_id, OLD.user_id, OLD.secret_encrypted, OLD.created_at) THEN
        RAISE EXCEPTION 'workspace factor identity and secret are immutable; rotate with a new factor' USING ERRCODE = '23514';
    END IF;
    IF (OLD.state = 'revoked' AND NEW.state <> 'revoked') OR (OLD.state = 'verified' AND NEW.state = 'pending') THEN
        RAISE EXCEPTION 'workspace factor state cannot move backwards' USING ERRCODE = '23514';
    END IF;
    IF OLD.last_accepted_counter IS NOT NULL AND (NEW.last_accepted_counter IS NULL OR NEW.last_accepted_counter < OLD.last_accepted_counter) THEN
        RAISE EXCEPTION 'workspace factor counter cannot decrease' USING ERRCODE = '23514';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state THEN
        NEW.revision := gen_random_uuid();
    ELSE
        NEW.revision := OLD.revision;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER workspace_mfa_factor_retained BEFORE UPDATE ON workspace_mfa_factors
    FOR EACH ROW EXECUTE FUNCTION retain_workspace_mfa_factor();

CREATE TABLE workspace_mfa_challenges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    workspace_id UUID NOT NULL,
    session_id UUID NOT NULL,
    user_id UUID NOT NULL,
    authentication_revision UUID NOT NULL,
    policy_revision UUID,
    policy_epoch BIGINT NOT NULL CHECK (policy_epoch >= 0),
    factor_scope TEXT NOT NULL CHECK (factor_scope IN ('global', 'workspace')),
    factor_id UUID NOT NULL,
    factor_revision UUID NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('enroll', 'step_up', 'policy_test', 'rotate', 'disable', 'recovery_codes')),
    test_id UUID,
    failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_members(workspace_id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (session_id, user_id, authentication_revision) REFERENCES session_authentication_evidence(session_id, user_id, revision) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, session_id, user_id, test_id) REFERENCES workspace_access_policy_tests(workspace_id, session_id, user_id, id) ON DELETE CASCADE,
    CHECK ((policy_revision IS NULL) = (policy_epoch = 0)),
    CHECK ((purpose = 'policy_test') = (test_id IS NOT NULL)),
    CHECK (completed_at IS NULL OR consumed_at IS NOT NULL),
    CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX idx_workspace_mfa_challenge_pending ON workspace_mfa_challenges (workspace_id, session_id, purpose) WHERE consumed_at IS NULL;
CREATE INDEX idx_workspace_mfa_challenge_member ON workspace_mfa_challenges (workspace_id, user_id, id);
CREATE INDEX idx_workspace_mfa_challenge_authentication ON workspace_mfa_challenges (session_id, user_id, authentication_revision);
CREATE INDEX idx_workspace_mfa_challenge_test ON workspace_mfa_challenges (workspace_id, session_id, user_id, test_id) WHERE test_id IS NOT NULL;
CREATE INDEX idx_workspace_mfa_challenge_expiry ON workspace_mfa_challenges (expires_at, id);

CREATE TABLE workspace_mfa_recovery_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    user_id UUID NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('factor', 'policy')),
    revision UUID NOT NULL,
    factor_id UUID,
    factor_revision UUID,
    code_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(code_hash) = 32),
    spent_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_members(workspace_id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, user_id, factor_id) REFERENCES workspace_mfa_factors(workspace_id, user_id, id) ON DELETE CASCADE,
    CHECK ((purpose = 'factor' AND factor_id IS NOT NULL AND factor_revision IS NOT NULL)
        OR (purpose = 'policy' AND factor_id IS NULL AND factor_revision IS NULL))
);
CREATE INDEX idx_workspace_mfa_recovery_member ON workspace_mfa_recovery_codes (workspace_id, user_id, purpose, revision);
CREATE INDEX idx_workspace_mfa_recovery_factor ON workspace_mfa_recovery_codes (workspace_id, user_id, factor_id);
CREATE INDEX idx_workspace_mfa_recovery_user ON workspace_mfa_recovery_codes (user_id, id);
