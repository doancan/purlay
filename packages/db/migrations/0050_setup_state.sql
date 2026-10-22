-- 0050_setup_state
--
-- Where the setup in the browser stands (D-179 §4): the one-time code the log shows, the throttle on
-- guessing it, the one browser the setup is bound to, and how far that setup has come. Whether setup
-- is *finished* is not here: that is `server_settings.setup_completed_at`, its one home (0049).
--
--   * **One row, by construction**, held to one by its key as `server_settings` is, and made here, so
--     every reader can lock it and none has to make it first.
--   * **Digests only.** `code_digest` is the SHA-256 of the setup code and `claim_digest` of the claim
--     token, hex (`platform/tokens.ts`): a copy of the database opens no setup. The code itself is
--     written once, to the log, at the start that issued it; the token is handed to the browser once.
--     A code is spent by the claim it opens — both its columns are cleared.
--   * A code opens for an hour from `code_issued_at`.
--   * **The throttle is the server's, not an address's**: the code is a secret of the server, so
--     `failed_attempts` counts every wrong code, and the fifth sets `locked_until`. Both belong to the
--     code: the next code, issued at a start, begins with neither.
--   * **The claim** — its token's digest, when it was made, the browser that made it and when that
--     browser was last seen (`claim_seen_at`) — is all set or all empty. A claim idle for a day no
--     longer opens; one seen within fifteen minutes cannot be taken over by a newer code.
--   * `admin_user_id`: the administrator an unfinished setup made. A server with any *other* user is
--     set up, and its setup is closed (D-179 §4.8), so the one user the wizard itself makes does not
--     close it; finishing clears it, and from then on every user closes the setup.
--   * `step_reached`: the last step passed, of the closed set in `@purlay/types` (`SETUP_STEPS`). Steps
--     are passed in order, so every step up to it is passed and none after; one column says so whole.
--
-- No data moves. A server that has users already is closed by them, whatever this row says.
--
-- Amended in place (the takeover window and the code's hour use columns already here; the step check
-- now lets `finish` outlive the claim it spends) before it was ever applied beyond test and scratch
-- databases, which are rebuilt: `CONTRIBUTING.md` §1.6 forbids editing one that has run.

CREATE TABLE setup_state (
    id                BOOLEAN PRIMARY KEY DEFAULT TRUE,
    code_digest       TEXT,
    code_issued_at    TIMESTAMPTZ,
    failed_attempts   INTEGER NOT NULL DEFAULT 0,
    locked_until      TIMESTAMPTZ,
    claim_digest      TEXT,
    claimed_at        TIMESTAMPTZ,
    claimed_by        TEXT,
    claim_seen_at     TIMESTAMPTZ,
    admin_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    step_reached      TEXT,
    step_reached_at   TIMESTAMPTZ,

    CONSTRAINT setup_state_one_row CHECK (id),
    CONSTRAINT setup_state_code_digest CHECK (code_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT setup_state_code_whole CHECK ((code_digest IS NULL) = (code_issued_at IS NULL)),
    CONSTRAINT setup_state_failed_attempts CHECK (failed_attempts >= 0),
    CONSTRAINT setup_state_claim_digest CHECK (claim_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT setup_state_claimed_by CHECK (char_length(claimed_by) BETWEEN 1 AND 128),
    CONSTRAINT setup_state_claim_whole CHECK (
        (claim_digest IS NULL) = (claimed_at IS NULL)
        AND (claim_digest IS NULL) = (claimed_by IS NULL)
        AND (claim_digest IS NULL) = (claim_seen_at IS NULL)
    ),
    CONSTRAINT setup_state_step CHECK (step_reached IN (
        'claim', 'admin', 'address', 'github', 'email', 'policy', 'workspace', 'invite', 'finish'
    )),
    CONSTRAINT setup_state_step_whole CHECK ((step_reached IS NULL) = (step_reached_at IS NULL)),
    -- A step is a claim's, but for `finish`: finishing spends the claim.
    CONSTRAINT setup_state_step_needs_a_claim
        CHECK (step_reached IS NULL OR step_reached = 'finish' OR claim_digest IS NOT NULL)
);

-- A foreign key leads an index, as every one here does: a user's row deleted finds this one by it.
CREATE INDEX idx_setup_state_admin_user ON setup_state (admin_user_id) WHERE admin_user_id IS NOT NULL;

INSERT INTO setup_state (id) VALUES (TRUE);
