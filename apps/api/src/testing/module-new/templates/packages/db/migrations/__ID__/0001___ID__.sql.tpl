-- __ID__/0001___ID__
--
-- The __ID__ module's table: a workspace's rows. Keys run from this module to the core and nowhere else (D-250); it
-- cascades with the workspace, and the workspace's purge names it all the same (`features/__ID__/module.ts`).

CREATE TABLE __SNAKE__ (
    id           UUID PRIMARY KEY,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title        TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The list: a workspace's rows, newest first.
CREATE INDEX idx___SNAKE___workspace ON __SNAKE__(workspace_id, id DESC);
