-- 0078_google_sign_in
--
-- Sign in with Google (D-251): Google's OAuth client as a setting of the server's, kept the way GitHub's pair
-- (0049) and the single sign-on provider (0059) are (D-179 §6). Google's issuer and endpoints are fixed, so an
-- operator gives a client id and a secret and nothing else.
--
--   * **The secret is sealed by the application** (`platform/crypto.ts`, D-39 §6), with this column's own name
--     bound in, so a sealed value copied into another column does not open there. Never logged, exported or
--     returned.
--   * **Google is its pair, or nothing.** A client id without its secret, or a secret without its id, is a
--     half-written setting that would sign nobody in; the check refuses one, as 0049 does for GitHub. Empty
--     strings are refused too: a blank is not a setting.
--   * `users.google_made` records that Google *made* the account: the person's first way in was Google, not
--     a link sent to their address. It is the rule D-138 §2 sets for GitHub's accounts: while Google is
--     connected, such an account is never sent a sign-in link, because Google is how it was made and how it is
--     proved; it is told to use Google instead. An account made by email keeps its links, and a Google
--     account that is later disconnected from Google is linked again. FALSE for every account that exists now.
--
-- The table holds one row, so this runs inside the migrator's transaction; nothing moves, and a server that
-- never sets these reads NULL for both and sends nothing anywhere for Google.

ALTER TABLE server_settings ADD COLUMN google_client_id TEXT;

-- Sealed, base64: version, nonce, ciphertext and tag, bound to this column's name.
ALTER TABLE server_settings ADD COLUMN google_client_secret_encrypted TEXT;

ALTER TABLE server_settings
    ADD CONSTRAINT server_settings_google_pair
        CHECK ((google_client_id IS NULL) = (google_client_secret_encrypted IS NULL));

ALTER TABLE server_settings
    ADD CONSTRAINT server_settings_google_not_blank
        CHECK (google_client_id <> '' AND google_client_secret_encrypted <> '');

ALTER TABLE users ADD COLUMN google_made BOOLEAN NOT NULL DEFAULT false;
