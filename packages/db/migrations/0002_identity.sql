-- 0002_identity
--
-- Global accounts and their sessions.
--
-- Append-only: never edited after it has been applied. The migrations are the
-- single source for the data model; packages/db/src/schema.ts is generated from
-- them and never written by hand. (D-45, CONTRIBUTING.md §1.6)

CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Nullable for two reasons: Phase 2 magic-link accounts have no GitHub identity (D-11),
    -- and erasure clears this column so a returning person gets a new account rather than
    -- resurrecting the one they asked to have removed (D-38). UNIQUE permits many NULLs.
    github_id     BIGINT UNIQUE,

    -- The stable identity anchor across auth methods. Normalised to lowercase ASCII by the
    -- application; COLLATE "C" so comparison is byte-wise and identical everywhere. (D-40)
    email         TEXT COLLATE "C" NOT NULL UNIQUE,

    -- 39 characters is GitHub's maximum username length.
    username      VARCHAR(39) COLLATE "C" NOT NULL UNIQUE,
    display_name  VARCHAR(128) NOT NULL,
    avatar_url    TEXT,

    -- Best-effort, updated lazily. Live presence is in-memory and never persisted. (D-7)
    last_seen_at  TIMESTAMPTZ,

    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- Soft delete, so authorship on historical messages survives. (D-22)
    deleted_at    TIMESTAMPTZ
);

CREATE TABLE sessions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- SHA-256 of the opaque token. The raw token exists only in the user's cookie:
    -- a database dump therefore does not hand over live sessions.
    token_hash   TEXT NOT NULL UNIQUE,

    user_agent   TEXT,
    ip_address   INET,

    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked_at   TIMESTAMPTZ
);

CREATE INDEX idx_sessions_user    ON sessions (user_id);
CREATE INDEX idx_sessions_expiry  ON sessions (expires_at) WHERE revoked_at IS NULL;
