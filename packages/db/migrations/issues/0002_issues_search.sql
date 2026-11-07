-- purlay: no-transaction
-- issues/0002_issues_search
--
-- The workspace-wide find reads an issue's title and its body for the words (D-285). Two indexes, one for each, the way chat's
-- search has them for its three places (`0043`, `0081`): the find asks the title and the body in two queries of their own and
-- merges them, because one `OR` is served by neither (#1019).
--
-- Each is the trigram index of the folded text, in a workspace, which is the expression the query states: `purlay_fold(title)`
-- compared with the folded words. That is why a find is at least three characters (`SEARCH_QUERY_MIN`). `purlay_fold` and
-- `pg_trgm` are the core's (`0043`).
--
-- Written for a table that has rows: outside the migrator's transaction (D-86) so the build does not block the writers of
-- issues, and dropped first so a run interrupted mid-build can be run again.

DROP INDEX CONCURRENTLY IF EXISTS idx_issues_search_title;
CREATE INDEX CONCURRENTLY idx_issues_search_title
    ON issues USING gin (workspace_id, purlay_fold(title) gin_trgm_ops);

DROP INDEX CONCURRENTLY IF EXISTS idx_issues_search_body;
CREATE INDEX CONCURRENTLY idx_issues_search_body
    ON issues USING gin (workspace_id, purlay_fold(body) gin_trgm_ops);
