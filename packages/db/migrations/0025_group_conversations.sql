-- purlay: no-transaction
-- 0025_group_conversations
--
-- A direct message with more than two people (#486, D-127). It stays a `direct_message`, and its
-- identity stays its people: `dm_key` is their ids, sorted, joined with ':' — now two to ten of
-- them (I-5). The same set of people opens the same conversation.
--
--   dm_key_form   2..10 lower-case ids joined with ':'. Two may be equal (a note to self: one id
--                 twice) and are sorted not descending, as before; three or more are strictly
--                 ascending, so `a:a:b` is not a key.
--
-- The ordering is a function: a CHECK cannot hold a subquery, and a regular expression cannot
-- compare its parts. It is IMMUTABLE, uses only pg_catalog (a restore runs with an empty
-- search_path), and replacing it later never re-checks rows already written — a change to it is a
-- new constraint, validated, as this one is.
--
-- Written for a table that has rows, and run outside the migrator's transaction (D-86), in
-- 0010's order: the new check is added NOT VALID and validated (existing two-id keys pass) before
-- the old one goes, so there is no moment without one; then it takes the old one's name, which the
-- constraint tests and the error mapping read. Each step can run again.

SET lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.member_key_is_sorted(key TEXT) RETURNS BOOLEAN
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    SET search_path = pg_catalog
AS $$
    SELECT CASE
        WHEN pg_catalog.cardinality(ids) = 2
            THEN ids[1] COLLATE "C" <= ids[2] COLLATE "C"
        ELSE NOT EXISTS (
            SELECT 1
            FROM pg_catalog.generate_subscripts(ids, 1) AS i
            WHERE i > 1 AND ids[i - 1] COLLATE "C" >= ids[i] COLLATE "C"
        )
    END
    FROM (SELECT pg_catalog.string_to_array(key, ':') AS ids) AS parts
$$;

ALTER TABLE channels DROP CONSTRAINT IF EXISTS dm_key_form_people;
ALTER TABLE channels
    ADD CONSTRAINT dm_key_form_people
    CHECK (
        dm_key IS NULL
        OR (
            dm_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}){1,9}$'
            AND public.member_key_is_sorted(dm_key)
        )
    ) NOT VALID;
ALTER TABLE channels VALIDATE CONSTRAINT dm_key_form_people;

ALTER TABLE channels DROP CONSTRAINT IF EXISTS dm_key_form;
ALTER TABLE channels RENAME CONSTRAINT dm_key_form_people TO dm_key_form;

RESET lock_timeout;
