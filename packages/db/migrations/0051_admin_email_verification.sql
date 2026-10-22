-- 0051_admin_email_verification
--
-- The setup administrator's own address check (D-179 §4.3, Ruling R32): the one link the wizard mails
-- to the administrator, whose following marks `users.email_verified` — never the sign-in library's
-- magic link, which on an account whose address was never proven removes its password.
--
--   * **One row at most, by construction**: one administrator is made by setup, and a new link
--     replaces the one before it, so the key is the same `BOOLEAN` held to `TRUE` as `setup_state`'s.
--   * **Its own table, not `setup_state`'s columns**, because it outlives the setup: the letter can be
--     opened after *Finish*, which clears `setup_state.admin_user_id` (D-179 §4.8) and spends the claim,
--     so the row names its account itself, and following it needs neither.
--   * **A digest only.** `token_digest` is the SHA-256 of the link's token, hex (`platform/tokens.ts`):
--     a copy of the database follows no link. The token is mailed once, in the link's fragment.
--   * **Bound to the address it was mailed to**: `email`, as `users.email` held it then. A link followed
--     after the account's address changed verifies nothing — it proves the old mailbox, not the new.
--   * A link opens for a day from `issued_at`; following it deletes the row, so it opens once. A row
--     past its day is deleted when it is tried, and by the daily sweep (`sweep:email-sign-ins`).
--   * **The account goes, the row goes**: `ON DELETE CASCADE` for a row deleted, and erasure — which
--     keeps the row under an anonymised account (D-139 §5) — deletes it by `user_id` itself.
--
-- No data moves.
--
-- Amended in place (the `email` column, found in review) before it was ever applied beyond test and
-- scratch databases, which are rebuilt: `CONTRIBUTING.md` §1.6 forbids editing one that has run.

CREATE TABLE admin_email_verification (
    id            BOOLEAN PRIMARY KEY DEFAULT TRUE,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email         TEXT NOT NULL,
    token_digest  TEXT NOT NULL,
    issued_at     TIMESTAMPTZ NOT NULL,

    CONSTRAINT admin_email_verification_one_row CHECK (id),
    CONSTRAINT admin_email_verification_digest CHECK (token_digest ~ '^[0-9a-f]{64}$')
);

-- A foreign key leads an index, as every one here does: a user's row deleted finds this one by it.
CREATE INDEX idx_admin_email_verification_user ON admin_email_verification (user_id);
