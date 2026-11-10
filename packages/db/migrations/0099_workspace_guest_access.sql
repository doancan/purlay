-- 0099_workspace_guest_access
--
-- Restricted guest authority is part of the existing membership, not a parallel organization.
-- Existing memberships and invitations keep their member behavior. Guest admission remains disabled
-- until all channel/message/file guards and the invitation flow support the new access descriptor.
-- Guest modules are opaque core-owned scope labels: this migration references no module table.

ALTER TABLE workspace_members
    ADD COLUMN access_kind TEXT NOT NULL DEFAULT 'member',
    ADD COLUMN guest_since TIMESTAMPTZ,
    ADD COLUMN guest_expires_at TIMESTAMPTZ,
    ADD COLUMN guest_modules TEXT[],
    ADD CONSTRAINT workspace_members_access_kind CHECK (access_kind IN ('member', 'guest')),
    ADD CONSTRAINT workspace_members_guest_authority CHECK (
        (access_kind = 'member' AND guest_since IS NULL AND guest_expires_at IS NULL AND guest_modules IS NULL)
        OR
        (access_kind = 'guest' AND role = 'member' AND guest_since IS NOT NULL
         AND guest_modules IS NOT NULL AND cardinality(guest_modules) > 0
         AND (guest_expires_at IS NULL OR guest_expires_at > guest_since))
    );

CREATE INDEX idx_workspace_members_guest_expiry ON workspace_members (guest_expires_at, workspace_id, user_id)
    WHERE access_kind = 'guest' AND guest_expires_at IS NOT NULL;

ALTER TABLE workspace_invitations
    ADD COLUMN access_kind TEXT NOT NULL DEFAULT 'member',
    ADD COLUMN guest_email TEXT,
    ADD COLUMN guest_channels UUID[],
    ADD COLUMN guest_modules TEXT[],
    ADD COLUMN guest_access_expires_at TIMESTAMPTZ,
    ADD CONSTRAINT workspace_invitations_access_kind CHECK (access_kind IN ('member', 'guest')),
    ADD CONSTRAINT workspace_invitations_guest_authority CHECK (
        (access_kind = 'member' AND guest_email IS NULL AND guest_channels IS NULL
         AND guest_modules IS NULL AND guest_access_expires_at IS NULL)
        OR
        (access_kind = 'guest' AND guest_email IS NOT NULL AND length(guest_email) BETWEEN 3 AND 254
         AND guest_channels IS NOT NULL AND cardinality(guest_channels) BETWEEN 1 AND 20
         AND guest_modules IS NOT NULL AND cardinality(guest_modules) > 0
         AND (guest_access_expires_at IS NULL OR guest_access_expires_at > created_at))
    );
