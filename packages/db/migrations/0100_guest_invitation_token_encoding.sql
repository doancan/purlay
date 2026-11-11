-- purlay: no-transaction
-- 0100_guest_invitation_token_encoding
-- Install the tagged writer constraint atomically, migrate legacy guest digests in committed batches,
-- then validate existing rows in a separate statement. Reruns keep already-tagged values unchanged.
SET lock_timeout = '10s';

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'workspace_invitations'::regclass
          AND conname = 'workspace_invitations_token_is_a_digest'
          AND pg_get_constraintdef(oid) NOT LIKE '%access_kind%'
    ) THEN
        ALTER TABLE workspace_invitations DROP CONSTRAINT workspace_invitations_token_is_a_digest;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'workspace_invitations'::regclass
          AND conname = 'workspace_invitations_token_is_a_digest'
    ) THEN
        ALTER TABLE workspace_invitations
            ADD CONSTRAINT workspace_invitations_token_is_a_digest CHECK (
                (access_kind = 'member' AND token_hash ~ '^[0-9a-f]{64}$')
                OR (access_kind = 'guest' AND token_hash ~ '^guest:[0-9a-f]{64}$')
            ) NOT VALID;
    END IF;
END;
$$;

DO $$
DECLARE changed INTEGER;
BEGIN
    LOOP
        UPDATE workspace_invitations
            SET token_hash = 'guest:' || token_hash
            WHERE id IN (
                SELECT id FROM workspace_invitations
                WHERE access_kind = 'guest' AND token_hash ~ '^[0-9a-f]{64}$'
                ORDER BY id LIMIT 1000
            );
        GET DIAGNOSTICS changed = ROW_COUNT;
        COMMIT;
        EXIT WHEN changed = 0;
    END LOOP;
END;
$$;

ALTER TABLE workspace_invitations VALIDATE CONSTRAINT workspace_invitations_token_is_a_digest;
RESET lock_timeout;
