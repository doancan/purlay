-- D-204: additive metadata on roots; old rows and clients keep their behavior.
ALTER TABLE messages ADD COLUMN is_question BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE messages ADD COLUMN question_assignee_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN accepted_answer_id UUID REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN decision_note TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN decision_url TEXT;
ALTER TABLE messages ADD COLUMN decision_updated_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN knowledge_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE messages ADD CONSTRAINT messages_knowledge_root CHECK (
    parent_id IS NULL OR (
        NOT is_question AND question_assignee_id IS NULL AND accepted_answer_id IS NULL
        AND decision_note = '' AND decision_url IS NULL AND knowledge_version = 0
    )
);
ALTER TABLE messages ADD CONSTRAINT messages_decision_note_length CHECK (char_length(decision_note) <= 2000);
ALTER TABLE messages ADD CONSTRAINT messages_decision_url_length CHECK (char_length(decision_url) <= 2048);
ALTER TABLE messages ADD CONSTRAINT messages_knowledge_version CHECK (knowledge_version >= 0);
ALTER TABLE messages ADD CONSTRAINT messages_question_assignee CHECK (question_assignee_id IS NULL OR is_question);
ALTER TABLE messages ADD CONSTRAINT messages_answer_not_self CHECK (accepted_answer_id IS NULL OR accepted_answer_id <> id);

CREATE TABLE saved_searches (
    id            UUID PRIMARY KEY,
    workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    query         JSONB NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT saved_searches_name CHECK (char_length(name) BETWEEN 1 AND 80),
    CONSTRAINT saved_searches_query_object CHECK (jsonb_typeof(query) = 'object')
);
CREATE INDEX idx_saved_searches_owner ON saved_searches (workspace_id, user_id, id DESC);
CREATE INDEX idx_saved_searches_user ON saved_searches (user_id);
