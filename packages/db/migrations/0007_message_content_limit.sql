-- 0007_message_content_limit
--
-- The longest message, enforced where every writer passes — not only the two
-- doors the contract guards today, but a job, a script or an import tomorrow.
--
-- The number is the contract's `MESSAGE_CONTENT_MAX` (packages/types/src/models.ts).
-- The contract counts UTF-16 code units and `char_length` counts code points,
-- which are never more — so this refuses nothing the contract accepts, and an
-- integration test fails if the two numbers part (D-67).
--
-- Added NOT VALID and validated separately, which on a large table is only half the
-- technique: ADD CONSTRAINT takes an ACCESS EXCLUSIVE lock, and inside a transaction
-- (as this file runs) that lock is held until commit, so the VALIDATE that follows
-- scans every row while every other query on the table waits. It is harmless here
-- because the table was empty. A constraint on a table that has rows must go in a
-- file that opts out of its transaction (`-- purlay: no-transaction`, D-86), where
-- the lock is released after the instant ADD CONSTRAINT takes and VALIDATE lets reads
-- and writes continue. This file does not show that shape, and it is not to be copied.
--
-- Append-only: never edited after it has been applied. The migrations are the
-- single source for the data model; packages/db/src/schema.ts is generated from
-- them and never written by hand. (D-45, CONTRIBUTING.md §1.6)

ALTER TABLE messages
    ADD CONSTRAINT messages_content_length CHECK (char_length(content) <= 16000) NOT VALID;

ALTER TABLE messages VALIDATE CONSTRAINT messages_content_length;
