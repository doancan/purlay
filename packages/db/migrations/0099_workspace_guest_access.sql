-- purlay: no-transaction
-- 0099_workspace_guest_access
-- Constant-default columns expand first; constraints validate separately while writes continue.
SET lock_timeout = '10s';

ALTER TABLE workspace_members
    ADD COLUMN IF NOT EXISTS access_kind TEXT NOT NULL DEFAULT 'member',
    ADD COLUMN IF NOT EXISTS guest_since TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS guest_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS guest_modules TEXT[];

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'workspace_members'::regclass AND conname = 'workspace_members_access_kind') THEN
        ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_access_kind CHECK (access_kind IN ('member', 'guest')) NOT VALID;
    END IF;
END;
$$;

ALTER TABLE workspace_members VALIDATE CONSTRAINT workspace_members_access_kind;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'workspace_members'::regclass AND conname = 'workspace_members_guest_authority') THEN
        ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_guest_authority CHECK (
        (access_kind = 'member' AND guest_since IS NULL AND guest_expires_at IS NULL AND guest_modules IS NULL)
        OR
        (access_kind = 'guest' AND role = 'member' AND guest_since IS NOT NULL
         AND guest_modules IS NOT NULL AND cardinality(guest_modules) > 0
         AND (guest_expires_at IS NULL OR guest_expires_at > guest_since))
    ) NOT VALID;
    END IF;
END;
$$;

ALTER TABLE workspace_members VALIDATE CONSTRAINT workspace_members_guest_authority;

DROP INDEX CONCURRENTLY IF EXISTS idx_workspace_members_guest_expiry;
CREATE INDEX CONCURRENTLY idx_workspace_members_guest_expiry
    ON workspace_members (guest_expires_at, workspace_id, user_id)
    WHERE access_kind = 'guest' AND guest_expires_at IS NOT NULL;

ALTER TABLE workspace_invitations
    ADD COLUMN IF NOT EXISTS access_kind TEXT NOT NULL DEFAULT 'member',
    ADD COLUMN IF NOT EXISTS guest_email TEXT,
    ADD COLUMN IF NOT EXISTS guest_channels UUID[],
    ADD COLUMN IF NOT EXISTS guest_modules TEXT[],
    ADD COLUMN IF NOT EXISTS guest_access_expires_at TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'workspace_invitations'::regclass AND conname = 'workspace_invitations_access_kind') THEN
        ALTER TABLE workspace_invitations ADD CONSTRAINT workspace_invitations_access_kind CHECK (access_kind IN ('member', 'guest')) NOT VALID;
    END IF;
END;
$$;

ALTER TABLE workspace_invitations VALIDATE CONSTRAINT workspace_invitations_access_kind;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'workspace_invitations'::regclass AND conname = 'workspace_invitations_guest_authority') THEN
        ALTER TABLE workspace_invitations ADD CONSTRAINT workspace_invitations_guest_authority CHECK (
        (access_kind = 'member' AND guest_email IS NULL AND guest_channels IS NULL
         AND guest_modules IS NULL AND guest_access_expires_at IS NULL)
        OR
        (access_kind = 'guest' AND guest_email IS NOT NULL AND length(guest_email) BETWEEN 3 AND 254
         AND guest_channels IS NOT NULL AND cardinality(guest_channels) BETWEEN 1 AND 20
         AND guest_modules IS NOT NULL AND cardinality(guest_modules) > 0
         AND (guest_access_expires_at IS NULL OR guest_access_expires_at > created_at))
    ) NOT VALID;
    END IF;
END;
$$;

ALTER TABLE workspace_invitations VALIDATE CONSTRAINT workspace_invitations_guest_authority;

RESET lock_timeout;
