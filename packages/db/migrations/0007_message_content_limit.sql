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
-- Added NOT VALID and validated separately: adding a validated CHECK holds an
-- exclusive lock for the whole scan of existing rows, while VALIDATE takes a lock
-- that lets writes continue. Trivial on an empty table, and the shape every later
-- constraint on a large table should copy.
--
-- Append-only: never edited after it has been applied. The migrations are the
-- single source for the data model; packages/db/src/schema.ts is generated from
-- them and never written by hand. (D-45, CONTRIBUTING.md §1.6)

ALTER TABLE messages
    ADD CONSTRAINT messages_content_length CHECK (char_length(content) <= 16000) NOT VALID;

ALTER TABLE messages VALIDATE CONSTRAINT messages_content_length;
