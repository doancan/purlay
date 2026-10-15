-- purlay: no-transaction
-- 0043_messages_search_folded
--
-- Search ignores case by Unicode, not ASCII alone (#700).
--
-- The database is C, under which ILIKE folds ASCII letters only: Ç and ç, Ğ and ğ, Ä and ä were
-- different letters to a search, and Turkish's four i's (I ı İ i) never met — "çağrı" did not find
-- "ÇAĞRI", "istanbul" did not find "İstanbul". purlay_fold lowers by ICU's root collation, which knows
-- every script's cases, then makes the four i's one: ı becomes i, and the dot ICU leaves after an
-- İ's i (U+0307) goes. A language's own rule would be wrong for the other: Turkish lowers I to ı,
-- every other language to i, and one workspace writes both.
--
-- The search compares purlay_fold(content) with the folded words, so the trigram index is on the
-- same expression, still beside workspace_id so the scan stays inside one tenant (D-10). The index
-- on the raw content served that search alone, and goes.
--
-- Written as 0039 is, for a table with rows: outside the migrator's transaction (D-86) so the build
-- does not block writers, dropped first so a run interrupted mid-build can be run again.

-- The folded text is marked C again: ICU's collation would otherwise travel with it, and a LIKE
-- against a C pattern could not use an index built on an ICU-collated column (measured: a bitmap
-- scan on this index only with the C mark).
CREATE OR REPLACE FUNCTION purlay_fold(value text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    RETURN translate(lower(value COLLATE "und-x-icu"), 'ı' || U&'\0307', 'i') COLLATE "C";

DROP INDEX CONCURRENTLY IF EXISTS idx_messages_search_folded;
CREATE INDEX CONCURRENTLY idx_messages_search_folded
    ON messages USING gin (workspace_id, purlay_fold(content) gin_trgm_ops)
    WHERE deleted_at IS NULL;

DROP INDEX CONCURRENTLY IF EXISTS idx_messages_search;
