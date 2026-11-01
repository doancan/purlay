-- purlay: no-transaction
-- 0069_missed_mail
--
-- Email about what a person missed (D-240): a person who turns it on is sent one letter, at most one an hour,
-- about the mentions and direct messages that waited unread for them longer than a quarter of an hour.
--
--   * `users.missed_mail_since`: when the person turned it on; NULL is off, as every account is. Only what they
--     were told since then is ever mailed, so turning it on never mails a year of old mentions.
--   * `notifications.mailed_at`: when the letter took the notification — or passed it over for good, its
--     message gone or its channel no longer the person's. Never mailed twice: the job takes only rows where it
--     is NULL, under the person's row lock.
--   * `missed_mail_letters`: one row per letter sent: when (an hour must pass before the next), and the digest of
--     the link in it that turns the setting off without signing in (`platform/tokens.ts`: only the digest is
--     kept). Swept with the job thirty days after it was sent, when the link stops opening.
--
-- Rollback: nothing else reads these. `ALTER TABLE users DROP COLUMN missed_mail_since`, `ALTER TABLE
-- notifications DROP COLUMN mailed_at` and `DROP TABLE missed_mail_letters` in a new migration undo it; nobody is
-- mailed again.
--
-- On tables with rows, outside the migrator's transaction (D-86): nullable columns without a default are
-- catalogue changes; the new table has no rows. Each step can run again.

SET lock_timeout = '10s';

ALTER TABLE users ADD COLUMN IF NOT EXISTS missed_mail_since TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS mailed_at TIMESTAMPTZ;

RESET lock_timeout;

CREATE TABLE IF NOT EXISTS missed_mail_letters (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sent_at     TIMESTAMPTZ NOT NULL,
    stop_digest TEXT COLLATE "C" NOT NULL,

    CONSTRAINT missed_mail_letters_stop_digest_key UNIQUE (stop_digest)
);

-- The person's last letter, for the hour between two (D-240).
CREATE INDEX IF NOT EXISTS idx_missed_mail_letters_user
    ON missed_mail_letters (user_id, sent_at DESC);
