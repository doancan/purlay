-- purlay: no-transaction
-- 0081_message_search_branches
--
-- Workspace search reads a message's decision note and its accepted answer as well as its words (#1019).
--
-- The three were one OR, which no index can serve: the trigram index answers the words alone, so the
-- planner walked every message of the workspace newest first and filtered row by row, and the answer
-- branch became a subplan hashed whole before the LIMIT was looked at. A term that matched nothing read
-- the whole workspace. The search now asks each place its own question and merges the three under one
-- bound (`search.ts`); these are the other two places' indexes.
--
-- Both are partial: a decision note is written on a few roots and an answer is accepted on a few
-- questions, so each holds those rows and no others. Both are ordered the way the search reads, newest
-- first inside one workspace, so a page stops at its bound and a term that matches nothing reads only
-- the rows that have a note or an answer. The predicates are the ones the search states.
--
-- Written as 0043 is, for a table with rows: outside the migrator's transaction (D-86) so the build does
-- not block writers, dropped first so a run interrupted mid-build can be run again.

DROP INDEX CONCURRENTLY IF EXISTS idx_messages_search_noted;
CREATE INDEX CONCURRENTLY idx_messages_search_noted
    ON messages (workspace_id, id DESC)
    WHERE decision_note <> '' AND deleted_at IS NULL;

DROP INDEX CONCURRENTLY IF EXISTS idx_messages_search_answered;
CREATE INDEX CONCURRENTLY idx_messages_search_answered
    ON messages (workspace_id, id DESC)
    WHERE accepted_answer_id IS NOT NULL AND deleted_at IS NULL;
