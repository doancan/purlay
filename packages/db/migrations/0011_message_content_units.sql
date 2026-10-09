-- purlay: no-transaction
-- 0011_message_content_units
--
-- The database counts a message the way the contract does: in UTF-16 code units, which is
-- what `String.length` counts and what `MESSAGE_CONTENT_MAX` is in (D-67).
--
-- 0007 used `char_length`, which counts code points. That is never *more* than code units,
-- so it refused nothing the contract accepts — and, for the same reason, it accepted what
-- the contract refuses: sixteen thousand characters outside the Basic Multilingual Plane
-- (emoji, most of CJK extension B) are thirty-two thousand units and sixty-four thousand
-- bytes of content. A writer that is not one of the two doors could store that, and no
-- frame of 64 KiB could carry it back out. The frame-fit proof (message-content.test.ts)
-- is made in code units; this makes the stored data satisfy it.
--
-- A code point above U+FFFF is two units, so the length in units is the length in
-- characters plus the number of characters that are astral. PostgreSQL's regular
-- expressions take `\U00010000-\U0010FFFF` in a bracket expression, and `regexp_replace`
-- is immutable, as a CHECK requires.
--
-- Run outside the migrator's transaction (D-86), as a constraint on a table with rows must
-- be: ADD ... NOT VALID takes its lock for an instant, VALIDATE scans without blocking
-- readers or writers. It can be run again after a crash at any point: the replacement is
-- dropped first, and the old constraint is dropped only after the new one has validated.
-- A row that is over the limit in units fails the VALIDATE, loudly, with the old
-- constraint still in place.
--
-- Append-only: never edited after it has been applied. (D-45, CONTRIBUTING.md §1.6)

SET lock_timeout = '10s';

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_content_length_units;

ALTER TABLE messages
    ADD CONSTRAINT messages_content_length_units CHECK (
        char_length(content)
        + char_length(regexp_replace(content, '[^\U00010000-\U0010FFFF]', '', 'g'))
        <= 16000
    ) NOT VALID;
ALTER TABLE messages VALIDATE CONSTRAINT messages_content_length_units;

-- The name a violation is reported under, and the one the integration test binds, stays.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_content_length;
ALTER TABLE messages RENAME CONSTRAINT messages_content_length_units TO messages_content_length;
