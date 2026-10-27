-- 0059_server_settings_oidc
--
-- The organisation's single sign-on provider, as a setting of the server's (D-200): an OpenID Connect issuer,
-- the client id and secret this server is registered under, and the label of the button. It is the third way
-- to sign in beside GitHub's OAuth app (0049) and mail (D-138), kept the way those are (D-179 §6).
--
--   * **The secret is sealed by the application** (`platform/crypto.ts`, D-39 §6), with this column's own name
--     bound in, so a sealed value copied into another column does not open there. Never logged, exported or
--     returned.
--   * **A provider is its three parts, or nothing.** An issuer without a client, or a client without its
--     secret, is a half-written setting that would sign nobody in; the check refuses one, as 0049 does for
--     GitHub's pair. Empty strings are refused too: a blank is not a setting.
--   * `oidc_name` is the button's label and is optional: NULL says *Single sign-on*. Its width is
--     `OIDC_NAME_MAX` in `@purlay/types`.
--   * The issuer is stored as written and never normalised: the id_token's `iss` must equal it byte for byte.
--
-- The table holds one row, so this runs inside the migrator's transaction; nothing moves, and a server that
-- never sets these reads NULL for all four and sends nothing anywhere for single sign-on.

ALTER TABLE server_settings ADD COLUMN oidc_issuer TEXT;

ALTER TABLE server_settings ADD COLUMN oidc_client_id TEXT;

-- Sealed, base64: version, nonce, ciphertext and tag, bound to this column's name.
ALTER TABLE server_settings ADD COLUMN oidc_client_secret_encrypted TEXT;

ALTER TABLE server_settings ADD COLUMN oidc_name TEXT;

ALTER TABLE server_settings
    ADD CONSTRAINT server_settings_oidc_triple
        CHECK (
            (oidc_issuer IS NULL) = (oidc_client_id IS NULL)
            AND (oidc_issuer IS NULL) = (oidc_client_secret_encrypted IS NULL)
        );

ALTER TABLE server_settings
    ADD CONSTRAINT server_settings_oidc_not_blank
        CHECK (oidc_issuer <> '' AND oidc_client_id <> '' AND oidc_name <> '');

-- A label without a provider to label is a leftover, not a setting.
ALTER TABLE server_settings
    ADD CONSTRAINT server_settings_oidc_name_needs_provider
        CHECK (oidc_name IS NULL OR oidc_issuer IS NOT NULL);
