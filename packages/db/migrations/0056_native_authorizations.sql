-- 0056_native_authorizations
--
-- What lets the native application sign in without a password of its own (D-191): a one-time code, made
-- while a person is signed in in a browser and spent by the application that started the flow.
--
--   * **The code is never stored**: `code_digest` is the SHA-256 of its 64 hex digits (`platform/tokens.ts`),
--     the same stance as a session's token and an invitation passport's cookie — a copy of this table spends
--     nothing and names no code.
--   * **Bound to a secret only the application holds.** `challenge` is the base64url SHA-256 of a verifier the
--     application made and never sent; spending a code needs the verifier, so a code read from a URL, a log
--     or a screen is of no use to whoever read it.
--   * **Two minutes, once.** `expires_at` is two minutes after it was made, on the server's clock; `spent_at`
--     is set by the update that mints the session, which only one caller can win.
--   * **Wrong guesses are counted and survive their own refusal.** `wrong_verifiers` is incremented by a
--     spend that carried the wrong verifier; at five the code is burnt (`expires_at` brought to that moment),
--     so a code someone has seen costs them five guesses at a 256-bit value and costs its owner nothing until
--     then.
--   * **A person's own**: `user_id`, and at most five live at a time (the oldest makes room), so a retry never
--     locks anyone out and nobody fills the table.
--   * Never exported (`docs/DATA.md`); the daily sweep deletes a row a day past its expiry, and an erasure
--     deletes the person's rows.
--
-- No data moves.

CREATE TABLE native_authorizations (
    -- Application-supplied UUID: nothing reads this table in order.
    id               UUID PRIMARY KEY,
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_digest      TEXT NOT NULL,
    challenge        TEXT NOT NULL,
    wrong_verifiers  SMALLINT NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL,
    expires_at       TIMESTAMPTZ NOT NULL,
    spent_at         TIMESTAMPTZ,

    CONSTRAINT native_authorizations_code_is_a_digest CHECK (code_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT native_authorizations_challenge_is_a_digest CHECK (challenge ~ '^[A-Za-z0-9_-]{43}$'),
    CONSTRAINT native_authorizations_wrong_verifiers_bounded CHECK (wrong_verifiers BETWEEN 0 AND 5),
    CONSTRAINT native_authorizations_lasts CHECK (expires_at >= created_at),
    CONSTRAINT native_authorizations_code_unique UNIQUE (code_digest)
);

-- A foreign key leads an index, as every one here does: a person's rows are found by it, to count the live
-- ones and to delete them on an erasure.
CREATE INDEX idx_native_authorizations_user ON native_authorizations (user_id, expires_at);

-- The daily sweep: what expired a day ago.
CREATE INDEX idx_native_authorizations_expiry ON native_authorizations (expires_at);
