-- 0038_email_auth
--
-- Sign-in links sent by email (#81, D-138).
--
--   * One row a message sent: the address, lower-cased as every stored address is (D-40), and what it
--     was — a `link`, with the SHA-256 of its token (never the token, `platform/tokens.ts`, so a copy
--     of this table opens nothing), or `github`, telling an address of a GitHub account to sign in
--     there, with no token. Both count toward the address's limit, so neither can flood a mailbox.
--   * Fifteen minutes from `created_at`, once: `used_at` is set by the one use, in the statement that
--     checks it was not.
--   * No user id: a link to an address no account has is how an account is made, on its use. Erasure
--     (D-27) deletes a person's pending links as it rewrites their address.
--   * The per-address limit counts an address's links in the last hour: the index on both.
--
-- A new table with no rows: one transaction, as 0026.

CREATE TABLE email_sign_ins (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email       TEXT NOT NULL,
    kind        TEXT NOT NULL,
    token_hash  TEXT UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,

    CONSTRAINT email_sign_ins_email_lower CHECK (email = lower(email) AND char_length(email) <= 254),
    CONSTRAINT email_sign_ins_kind CHECK (kind IN ('link', 'github')),
    CONSTRAINT email_sign_ins_token_hash CHECK (
        (kind = 'link') = (token_hash IS NOT NULL) AND (token_hash IS NULL OR token_hash ~ '^[0-9a-f]{64}$')
    ),
    CONSTRAINT email_sign_ins_expiry CHECK (expires_at > created_at)
);

CREATE INDEX idx_email_sign_ins_email ON email_sign_ins (email, created_at);
