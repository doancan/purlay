-- 0020_integrations
--
-- The workspace's GitHub credential and the unfurl cache (D-11, D-23; `SCHEMA.md` §8).
--
--   * `github_integrations` is one row per workspace — never per user, which would leak which
--     private repositories a member can see through whether a card renders. The token is sealed by
--     the application (`platform/crypto.ts`, D-39 §6) with the row's id bound in, so the id is the
--     application's, given before the seal; it is never logged and never returned.
--   * `link_previews` caches public metadata about a URL, keyed by the URL's hash, with its own
--     expiry; a private repository's card is served only to the workspace whose token fetched it,
--     which the unfurl endpoint checks (#66), not this table.
--   * Every foreign-key column is indexed (D-89): `workspace_id` by its UNIQUE constraint.
--
-- Re-runnable: what it adds is dropped first.

DROP TABLE IF EXISTS link_previews;
DROP TABLE IF EXISTS github_integrations;

CREATE TABLE github_integrations (
    id              UUID PRIMARY KEY,
    workspace_id    UUID NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
    installation_id BIGINT,
    -- Sealed, base64: version, nonce, ciphertext and tag. Null once removed.
    access_token_encrypted TEXT,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_github_integrations_created_by ON github_integrations (created_by)
    WHERE created_by IS NOT NULL;

CREATE TABLE link_previews (
    url_hash    TEXT PRIMARY KEY,
    url         TEXT NOT NULL,
    payload     JSONB NOT NULL,
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_link_previews_expiry ON link_previews (expires_at);
