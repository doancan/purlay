-- 0075_github_app
--
-- A GitHub App beside the workspace's read-only token (D-246): the server's App, a workspace's installation of
-- it, a person's own authorization to write as themselves, the handshakes that bring the two back from GitHub,
-- and the App's deliveries.
--
--   * **The App is a setting of the server's** (D-179 §6), as GitHub's OAuth app (0049) and single sign-on
--     (0059) are: its id, its slug and its client id in the clear; its client secret, its private key and its
--     webhook secret sealed by the application (`platform/crypto.ts`, D-39 §6), each with its column's name
--     bound in. All six or none: a half-written App would sign nothing GitHub believes.
--   * `github_app_installations`: at most one installation per workspace, connected by an owner. GitHub's
--     installation id is not unique here — two workspaces of one organisation may both connect it — and is
--     indexed for the deliveries that name it. A suspension is GitHub's and is kept as said.
--   * `github_user_authorizations`: a person's own App user access token and its refresh token, one per person,
--     never a workspace's (D-246 §2): sealed with the row's id and the column bound in. The expiries are
--     GitHub's; an App whose tokens do not expire leaves them NULL. Found by GitHub's account id when GitHub
--     says the person revoked it.
--   * `github_app_handshakes`: a trip to GitHub and back — an owner installing, or a person authorizing — by
--     the digest of the `state` it carries (`platform/tokens.ts`: only the digest is kept), its person, its
--     workspace for an installation, and the PKCE verifier of an authorization, sealed. Spent on return, and
--     swept ten minutes after it was made.
--   * `github_app_deliveries`: each delivery to the App's one address, by its id and its body's digest, posted
--     once (as D-134 §5 and D-231 §1 say of a feed's); swept with them after thirty days.
--
-- Rollback: nothing outside the App's own module reads these. Drop the four tables and the six columns in a new
-- migration; the workspace token, the feeds and the cards keep working as they did (D-246 §6).
--
-- New tables with no rows, and nullable columns on the one-row `server_settings`: one transaction, as 0059.

ALTER TABLE server_settings ADD COLUMN github_app_id BIGINT;

ALTER TABLE server_settings ADD COLUMN github_app_slug TEXT;

ALTER TABLE server_settings ADD COLUMN github_app_client_id TEXT;

-- Sealed, base64: version, nonce, ciphertext and tag, each bound to its column's name.
ALTER TABLE server_settings ADD COLUMN github_app_client_secret_encrypted TEXT;

ALTER TABLE server_settings ADD COLUMN github_app_private_key_encrypted TEXT;

ALTER TABLE server_settings ADD COLUMN github_app_webhook_secret_encrypted TEXT;

ALTER TABLE server_settings
    ADD CONSTRAINT server_settings_github_app_whole
        CHECK (
            (github_app_id IS NULL) = (github_app_slug IS NULL)
            AND (github_app_id IS NULL) = (github_app_client_id IS NULL)
            AND (github_app_id IS NULL) = (github_app_client_secret_encrypted IS NULL)
            AND (github_app_id IS NULL) = (github_app_private_key_encrypted IS NULL)
            AND (github_app_id IS NULL) = (github_app_webhook_secret_encrypted IS NULL)
        );

ALTER TABLE server_settings
    ADD CONSTRAINT server_settings_github_app_shape
        CHECK (
            github_app_id > 0
            AND github_app_slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'
            AND github_app_client_id <> ''
        );

CREATE TABLE github_app_installations (
    id              UUID PRIMARY KEY,
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    installation_id BIGINT NOT NULL,
    account_login   VARCHAR(39) NOT NULL,
    account_type    VARCHAR(16) NOT NULL,
    suspended_at    TIMESTAMPTZ,
    connected_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    connected_at    TIMESTAMPTZ NOT NULL,

    CONSTRAINT github_app_installations_workspace_key UNIQUE (workspace_id),
    CONSTRAINT github_app_installations_installation_positive CHECK (installation_id > 0),
    CONSTRAINT github_app_installations_account_type_known
        CHECK (account_type IN ('User', 'Organization'))
);

-- A delivery names the installation; every foreign key is indexed (D-89).
CREATE INDEX idx_github_app_installations_installation
    ON github_app_installations (installation_id);
CREATE INDEX idx_github_app_installations_connected_by
    ON github_app_installations (connected_by) WHERE connected_by IS NOT NULL;

CREATE TABLE github_user_authorizations (
    id                      UUID PRIMARY KEY,
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    github_user_id          BIGINT NOT NULL,
    github_login            VARCHAR(39) NOT NULL,
    access_token_encrypted  TEXT NOT NULL,
    access_expires_at       TIMESTAMPTZ,
    refresh_token_encrypted TEXT,
    refresh_expires_at      TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL,
    updated_at              TIMESTAMPTZ NOT NULL,

    CONSTRAINT github_user_authorizations_user_key UNIQUE (user_id),
    CONSTRAINT github_user_authorizations_github_user_positive CHECK (github_user_id > 0),
    -- An expiry belongs to a refresh token; a token that does not expire has neither.
    CONSTRAINT github_user_authorizations_refresh_expiry
        CHECK (refresh_expires_at IS NULL OR refresh_token_encrypted IS NOT NULL)
);

-- GitHub says who revoked by its own account id.
CREATE INDEX idx_github_user_authorizations_github_user
    ON github_user_authorizations (github_user_id);

CREATE TABLE github_app_handshakes (
    state_digest       TEXT COLLATE "C" PRIMARY KEY,
    user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id       UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    purpose            VARCHAR(16) NOT NULL,
    verifier_encrypted TEXT,
    return_to          VARCHAR(512),
    expires_at         TIMESTAMPTZ NOT NULL,

    CONSTRAINT github_app_handshakes_purpose_known CHECK (purpose IN ('install', 'authorize')),
    -- An installation is a workspace's and has no verifier; an authorization is the person's and has one.
    CONSTRAINT github_app_handshakes_purpose_shape CHECK (
        (purpose = 'install' AND workspace_id IS NOT NULL AND verifier_encrypted IS NULL)
        OR (purpose = 'authorize' AND workspace_id IS NULL AND verifier_encrypted IS NOT NULL)
    )
);

CREATE INDEX idx_github_app_handshakes_user ON github_app_handshakes (user_id);
CREATE INDEX idx_github_app_handshakes_workspace
    ON github_app_handshakes (workspace_id) WHERE workspace_id IS NOT NULL;
-- What the sweep deletes by.
CREATE INDEX idx_github_app_handshakes_expires ON github_app_handshakes (expires_at);

CREATE TABLE github_app_deliveries (
    -- GitHub's `X-GitHub-Delivery`; bounded, since it is a header anybody may send.
    delivery_id VARCHAR(64) COLLATE "C" PRIMARY KEY,
    body_digest TEXT COLLATE "C" NOT NULL,
    received_at TIMESTAMPTZ NOT NULL,

    CONSTRAINT github_app_deliveries_body_key UNIQUE (body_digest),
    CONSTRAINT github_app_deliveries_body_is_a_digest CHECK (body_digest ~ '^[0-9a-f]{64}$')
);

-- What the sweep deletes by.
CREATE INDEX idx_github_app_deliveries_received ON github_app_deliveries (received_at);
