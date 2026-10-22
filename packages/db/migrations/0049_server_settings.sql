-- 0049_server_settings
--
-- The operator's settings, kept in the database instead of the environment (D-179 §6): who may sign
-- up, GitHub's OAuth app, the mail relay, and who may make a workspace (D-155, D-169). A person can
-- change these in the browser, so they cannot live in a file the process reads once at start; what the
-- process needs before it can read a row — the database, the encryption key, the storage, `APP_URL` —
-- stays in the environment (`CONFIG.md`).
--
--   * **One row, by construction.** The key is a boolean that can only be TRUE, so a second row is
--     refused by the primary key rather than by every reader agreeing to take the first. Typed columns
--     rather than key/value rows: each setting has a type, a default and a rule the database can check,
--     and a reader gets a missing setting as a compile error, not as an absent key at run time.
--   * **The secrets are sealed by the application** (`platform/crypto.ts`, D-39 §6) — the GitHub
--     client secret, and the SMTP address, which carries the relay's password — with the column's own
--     name bound in, so a sealed value copied into the other column does not open there. They are
--     never logged, never exported and never returned (`modules/setup/settings.ts`).
--   * **Pairs are pairs.** A client id without its secret, or a relay without its sender, is a
--     half-written setting that would sign nobody in and send nothing; the checks refuse one.
--   * **Who may make a workspace** is D-155's rule as a kind and its logins: `first` (nobody but the
--     first person, on an empty instance), `anyone`, or `listed`, which needs at least one login.
--   * `imported_from_env_at`: when the environment's values were copied in. They are copied **once**,
--     on the first start; a set timestamp is what makes every later start leave the row alone.
--   * `setup_completed_at`: when the setup in the browser was finished; empty until it is.
--
-- No data moves: the row is made by the first start of a process that has this migration, from the
-- environment it was given.
--
-- `server_settings_mail_from` was added to this file before it was ever applied to a deployment's
-- database (only to test and scratch databases, which are rebuilt): the migration was still unshipped,
-- so it was amended rather than followed by another (`CONTRIBUTING.md` §1.6 forbids editing one that
-- has run).

CREATE TABLE server_settings (
    id                        BOOLEAN PRIMARY KEY DEFAULT TRUE,
    sign_up                   TEXT NOT NULL DEFAULT 'invite-only',
    github_client_id          TEXT,
    -- Sealed, base64: version, nonce, ciphertext and tag, bound to this column's name.
    github_client_secret_encrypted TEXT,
    -- Sealed, base64, as above: the whole `smtp://` or `smtps://` address, credentials and all.
    smtp_url_encrypted        TEXT,
    mail_from                 TEXT,
    smtp_allow_plaintext      BOOLEAN NOT NULL DEFAULT FALSE,
    workspace_creators        TEXT NOT NULL DEFAULT 'first',
    workspace_creator_logins  TEXT[] NOT NULL DEFAULT '{}',
    setup_completed_at        TIMESTAMPTZ,
    imported_from_env_at      TIMESTAMPTZ,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT server_settings_one_row CHECK (id),
    CONSTRAINT server_settings_sign_up CHECK (sign_up IN ('invite-only', 'open')),
    CONSTRAINT server_settings_github_pair
        CHECK ((github_client_id IS NULL) = (github_client_secret_encrypted IS NULL)),
    CONSTRAINT server_settings_github_client_id CHECK (github_client_id <> ''),
    CONSTRAINT server_settings_mail_from CHECK (mail_from <> ''),
    CONSTRAINT server_settings_mail_pair CHECK ((smtp_url_encrypted IS NULL) = (mail_from IS NULL)),
    CONSTRAINT server_settings_workspace_creators
        CHECK (workspace_creators IN ('first', 'anyone', 'listed')),
    CONSTRAINT server_settings_creator_logins
        CHECK ((workspace_creators = 'listed') = (cardinality(workspace_creator_logins) > 0))
);
