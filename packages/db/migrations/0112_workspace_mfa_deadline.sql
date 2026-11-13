-- purlay: no-transaction
-- Base authentication/idle expiry is terminal; MFA expiry alone permits a fresh MFA step-up (D-310).
-- A legacy proof receives no lifetime extension: its old combined deadline remains the upper bound.
SET lock_timeout = '10s';
ALTER TABLE workspace_session_assurances ADD COLUMN IF NOT EXISTS mfa_expires_at TIMESTAMPTZ;

-- Walk the existing primary key once; each batch commits at most 5,000 legacy MFA rows.
-- A restart begins from the first key and only fills deadlines that are still missing.
DO $$
DECLARE
    last_workspace_id UUID := '00000000-0000-0000-0000-000000000000';
    last_session_id UUID := '00000000-0000-0000-0000-000000000000';
    changed INTEGER;
BEGIN
    LOOP
        WITH batch AS (
            SELECT workspace_id, session_id
              FROM workspace_session_assurances
             WHERE factor_scope IS NOT NULL AND mfa_expires_at IS NULL
               AND (workspace_id, session_id) >= (last_workspace_id, last_session_id)
             ORDER BY workspace_id, session_id
             LIMIT 5000
        ), updated AS (
            UPDATE workspace_session_assurances AS assurance
               SET mfa_expires_at = assurance.expires_at
              FROM batch
             WHERE (assurance.workspace_id, assurance.session_id) = (batch.workspace_id, batch.session_id)
               AND assurance.factor_scope IS NOT NULL AND assurance.mfa_expires_at IS NULL
            RETURNING assurance.workspace_id, assurance.session_id
        )
        SELECT workspace_id, session_id INTO last_workspace_id, last_session_id
          FROM updated ORDER BY workspace_id DESC, session_id DESC LIMIT 1;
        GET DIAGNOSTICS changed = ROW_COUNT;
        EXIT WHEN changed = 0;
        COMMIT;
    END LOOP;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_assurance_mfa_deadline' AND conrelid = 'workspace_session_assurances'::regclass) THEN
        ALTER TABLE workspace_session_assurances ADD CONSTRAINT workspace_assurance_mfa_deadline
            CHECK ((factor_scope IS NULL) = (mfa_expires_at IS NULL)) NOT VALID;
    END IF;
END $$;
ALTER TABLE workspace_session_assurances VALIDATE CONSTRAINT workspace_assurance_mfa_deadline;
RESET lock_timeout;
