-- 0053_invitation_passports
--
-- What lets a newcomer make an account on an invite-only server by an invitation link (D-179 §5,
-- Ruling R51): a passport, made from a live link, spent by the one sign-up it was made for.
--
--   * **Two kinds, by how the sign-up comes back.** `github`: the browser that asked holds a cookie, and
--     only that browser's return from GitHub spends it — `cookie_digest` is the SHA-256 of the cookie's
--     value, hex (`platform/tokens.ts`). `email`: the link in the mail may be opened in another browser,
--     so there is no cookie — `address_digest` is the SHA-256 of the lower-cased, trimmed address
--     (`normalisedMailbox`), and the mail's own link is the proof of the mailbox.
--   * **Digests only, never the value or the address**: a copy of the database spends no passport and
--     names nobody. Each kind holds its own digest and not the other's (the CHECKs).
--   * **One hour, one use.** `expires_at` is an hour after it was made; `consumed_at` is set by the
--     sign-up that spends it, in that sign-up's transaction, by an update that only one can win.
--   * **A passport is only as live as its invitation**: it names the link (`invitation_id`), and every
--     use re-reads the link — revoked, expired, or its workspace deleted, the passport opens nothing.
--     The link is never deleted (workspaces are restricted), so the cascade is for the day one is.
--   * **An address holds one passport per invitation**: asking again for the same address and link
--     replaces the one before it rather than adding another (the unique pair).
--   * Never exported (`docs/DATA.md`); the daily sweep deletes a row a day past its expiry or its use,
--     and an erasure deletes the person's `email` rows by the digest of the address it read before the
--     tombstone replaced it.
--
-- No data moves.

CREATE TABLE invitation_passports (
    -- Application-supplied UUID: nothing reads this table in order.
    id              UUID PRIMARY KEY,
    invitation_id   UUID NOT NULL REFERENCES workspace_invitations(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL,
    cookie_digest   TEXT,
    address_digest  TEXT,
    expires_at      TIMESTAMPTZ NOT NULL,
    consumed_at     TIMESTAMPTZ,

    CONSTRAINT invitation_passports_kind CHECK (kind IN ('github', 'email')),
    CONSTRAINT invitation_passports_digest_by_kind CHECK (
        (kind = 'github' AND cookie_digest IS NOT NULL AND address_digest IS NULL)
        OR (kind = 'email' AND address_digest IS NOT NULL AND cookie_digest IS NULL)
    ),
    CONSTRAINT invitation_passports_cookie_is_a_digest
        CHECK (cookie_digest IS NULL OR cookie_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT invitation_passports_address_is_a_digest
        CHECK (address_digest IS NULL OR address_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT invitation_passports_cookie_unique UNIQUE (cookie_digest),
    CONSTRAINT invitation_passports_address_once_per_invitation UNIQUE (invitation_id, address_digest)
);

-- Counting a link's live passports, and finding one by an address: the unique pair leads with the link,
-- and an address is looked up across links, so it has an index of its own.
CREATE INDEX idx_invitation_passports_address ON invitation_passports (address_digest)
    WHERE address_digest IS NOT NULL;

-- The daily sweep: what expired, or was spent, a day ago.
CREATE INDEX idx_invitation_passports_expiry ON invitation_passports (expires_at);
CREATE INDEX idx_invitation_passports_consumed ON invitation_passports (consumed_at)
    WHERE consumed_at IS NOT NULL;
