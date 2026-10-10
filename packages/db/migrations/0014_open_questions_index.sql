-- purlay: no-transaction
-- 0014_open_questions_index
--
-- The open-questions view (`GET /api/workspaces/:id/unresolved`, D-99 §5) asks for roots that
-- have a reply and no resolution, newest first, inside the channels the caller can see. The
-- index that served it, `idx_messages_unresolved`, held *every* unresolved root — and nearly
-- every root has no reply and never will — so the question "which of these have replies" was
-- answered by reading them all.
--
-- Measured on 400,000 messages in one workspace of 40 channels, caller able to see all of
-- them, 40 open questions among 360,000 unresolved roots (the plan the query really gets):
--   before:  a parallel sequential scan, 6,975 buffers, 37 ms (the planner did not even take
--            the old index: it is ordered by id, and nothing ordered would stop early);
--   after:   an index scan on the new definition, 41 buffers, 0.07 ms.
-- And where the caller can see two channels of forty and 1% of roots are open questions (a
-- busy workspace): 348 buffers / 1.6 ms before, 220 / 0.77 ms after — the plan was already
-- bounded by the channel there and stays so. The index shrinks with the question: it holds
-- what the view can show, which in a healthy workspace is a small fraction of its messages.
--
-- The index keeps its name and changes its predicate (`thread_reply_count > 0`), so what
-- refers to it by name — the documents, the schema test — still holds. A reply count only
-- ever goes up while a thread has live replies, and the view reads the same column the
-- predicate does, so the planner can use the index for exactly the rows the view returns; a
-- thread whose replies were all deleted drops out of the index when the count does.
--
-- Written the way 0009 is, for a table with rows: outside the migrator's transaction (D-86) so
-- the build does not block writers, and dropped-then-built so a run interrupted at any point
-- (which leaves an INVALID index `IF NOT EXISTS` would call present) can be run again. The
-- window between the two statements is a short one in which the view is slower, not wrong.

DROP INDEX CONCURRENTLY IF EXISTS idx_messages_unresolved;
CREATE INDEX CONCURRENTLY idx_messages_unresolved
    ON messages (workspace_id, id DESC)
    WHERE parent_id IS NULL
      AND resolved_at IS NULL
      AND deleted_at IS NULL
      AND thread_reply_count > 0;
