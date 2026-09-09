-- 0003_workspaces
--
-- Tenancy: workspaces and the membership row Deep Work lives on.
--
-- Append-only: never edited after it has been applied. The migrations are the
-- single source for the data model; packages/db/src/schema.ts is generated from
-- them and never written by hand. (D-45, CONTRIBUTING.md §1.6)

CREATE TABLE workspaces (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(64) NOT NULL,
    -- COLLATE "C": a slug is an identifier, not prose. (D-40)
    slug        VARCHAR(64) COLLATE "C" NOT NULL UNIQUE,
    avatar_url  TEXT,

    -- Audit only. Ownership is workspace_members.role = 'owner'. (D-22)
    created_by  UUID REFERENCES users(id) ON DELETE SET NULL,

    -- Self-hosters pay for the disk, so uploads are capped per workspace. (D-16)
    storage_quota_bytes BIGINT NOT NULL DEFAULT 5368709120,  -- 5 GiB
    storage_used_bytes  BIGINT NOT NULL DEFAULT 0,

    -- NULL means infinite, which is the default and the product's tenet: nothing is
    -- thrown away. An operator opts in; the purge job (D-30) enforces it. (D-27)
    retention_days      INTEGER,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at  TIMESTAMPTZ,

    CONSTRAINT storage_used_non_negative CHECK (storage_used_bytes >= 0),

    -- A floor, not a preference. A typo of `1` in a retention field would delete a
    -- team's memory overnight and no correct value is that small. (D-27)
    CONSTRAINT retention_days_sane
        CHECK (retention_days IS NULL OR retention_days >= 30)
);

CREATE INDEX idx_workspaces_slug ON workspaces (slug) WHERE deleted_at IS NULL;

CREATE TABLE workspace_members (
    id           UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      UUID NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
    role         user_role NOT NULL DEFAULT 'member',

    -- Server-side, so it holds across devices and so the server itself stops
    -- delivering. A purely client-side mute would still wake a phone. (D-15)
    is_deep_work_active BOOLEAN NOT NULL DEFAULT FALSE,
    deep_work_until     TIMESTAMPTZ,

    joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (workspace_id, user_id)
);

CREATE INDEX idx_workspace_members_user ON workspace_members (user_id);

-- Every workspace must retain at least one owner. Not expressible as a constraint;
-- enforced in the membership service and covered by a test. (D-21)
