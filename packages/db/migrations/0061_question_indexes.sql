-- purlay: no-transaction
-- D-204: build outside the schema transaction, so existing conversations remain writable.
-- Drop first: interrupted concurrent builds may leave an invalid index behind.

DROP INDEX CONCURRENTLY IF EXISTS idx_messages_questions;
CREATE INDEX CONCURRENTLY idx_messages_questions ON messages (workspace_id, id)
    WHERE is_question AND resolved_at IS NULL AND deleted_at IS NULL;

DROP INDEX CONCURRENTLY IF EXISTS idx_messages_question_assignee;
CREATE INDEX CONCURRENTLY idx_messages_question_assignee ON messages (question_assignee_id, id)
    WHERE question_assignee_id IS NOT NULL;

DROP INDEX CONCURRENTLY IF EXISTS idx_messages_accepted_answer;
CREATE INDEX CONCURRENTLY idx_messages_accepted_answer ON messages (accepted_answer_id)
    WHERE accepted_answer_id IS NOT NULL;

DROP INDEX CONCURRENTLY IF EXISTS idx_messages_decision_author;
CREATE INDEX CONCURRENTLY idx_messages_decision_author ON messages (decision_updated_by)
    WHERE decision_updated_by IS NOT NULL;

