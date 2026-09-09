-- 0001_extensions
--
-- Extensions and enumerated types. `citext` is deliberately absent (D-40).
--
-- Append-only: never edited after it has been applied. The migrations are the
-- single source for the data model; packages/db/src/schema.ts is generated from
-- them and never written by hand. (D-45, CONTRIBUTING.md §1.6)

-- Substring / identifier search. (D-10)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Lets a scalar column participate in a GIN index alongside a trigram column,
-- so search can be filtered by workspace without a full index scan.
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- citext is deliberately absent: it lowercases with the database locale, which makes email
-- uniqueness depend on how the server was provisioned. Email is TEXT COLLATE "C", normalised
-- to lowercase ASCII by the application before it is stored or compared. (D-40)

CREATE TYPE user_role           AS ENUM ('owner', 'admin', 'member');
CREATE TYPE channel_type        AS ENUM ('public', 'private', 'direct_message');
CREATE TYPE message_type        AS ENUM ('text', 'system_event');
CREATE TYPE attachment_kind     AS ENUM ('image', 'video', 'audio', 'file');
CREATE TYPE notification_level  AS ENUM ('all', 'mentions', 'none');
CREATE TYPE notification_type   AS ENUM ('mention', 'direct_message', 'thread_reply', 'thread_resolved');
