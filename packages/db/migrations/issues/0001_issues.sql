-- issues/0001_issues
--
-- The issues module's one table (D-254): a workspace's issue, kept as small as the module that proves the
-- architecture end to end.
--
--   * Keys run from this module to the core and nowhere else (D-250): the workspace, and the two people an
--     issue names. Both people outlive their rows as NULL, as a channel's creator does: the issue is the
--     workspace's, not theirs.
--   * The assignee being a member of the workspace is the service's check, not a key: a member who leaves is
--     not a reason to rewrite their issues.
--   * Bounded where it is written: a title is one line, a body is markdown of at most ten thousand characters.
--   * Cascades with the workspace. The workspace's purge empties it by name (`features/issues/module.ts`) all
--     the same, because a purged workspace keeps its row as a tombstone and the cascade never fires.

CREATE TYPE issue_status AS ENUM ('open', 'done');

CREATE TABLE issues (
    id           UUID PRIMARY KEY,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title        TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
    body         TEXT NOT NULL DEFAULT '' CHECK (char_length(body) <= 10000),
    status       issue_status NOT NULL DEFAULT 'open',
    assignee_id  UUID REFERENCES users(id) ON DELETE SET NULL,
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The list: a workspace's issues, newest first, by the key a page continues from.
CREATE INDEX idx_issues_workspace ON issues(workspace_id, id DESC);
CREATE INDEX idx_issues_assignee ON issues(assignee_id) WHERE assignee_id IS NOT NULL;
CREATE INDEX idx_issues_created_by ON issues(created_by) WHERE created_by IS NOT NULL;
