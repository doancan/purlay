-- 0100_guest_invitation_token_encoding
--
-- Older invitation readers compare a plain hexadecimal SHA-256 digest. A guest token must never
-- match that lookup, even during a mixed-version rollout: an older reader would admit its holder
-- as an unrestricted member. The type prefix encodes authority without weakening the token digest.

ALTER TABLE workspace_invitations DROP CONSTRAINT workspace_invitations_token_is_a_digest;

UPDATE workspace_invitations
    SET token_hash = 'guest:' || token_hash
    WHERE access_kind = 'guest' AND token_hash ~ '^[0-9a-f]{64}$';

ALTER TABLE workspace_invitations
    ADD CONSTRAINT workspace_invitations_token_is_a_digest CHECK (
        (access_kind = 'member' AND token_hash ~ '^[0-9a-f]{64}$')
        OR (access_kind = 'guest' AND token_hash ~ '^guest:[0-9a-f]{64}$')
    );
