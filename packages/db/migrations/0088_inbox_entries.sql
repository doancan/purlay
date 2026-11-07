-- The notices of any module, for one person in one workspace (D-286): the core's own table beside chat's `notifications`,
-- which stays bound to a message and a channel. `kind` is text, checked against the writing module's manifest by the
-- service, so that no module's set has to change a core enum to add one.
CREATE TABLE inbox_entries (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module text NOT NULL CHECK (module ~ '^[a-z][a-z0-9-]{0,31}$'),
  kind text NOT NULL CHECK (char_length(kind) BETWEEN 1 AND 48),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  subject_type text NOT NULL CHECK (char_length(subject_type) BETWEEN 1 AND 32),
  subject_id uuid NOT NULL,
  params jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(params) = 'object' AND octet_length(params::text) <= 1024),
  read_at timestamptz,
  created_at timestamptz NOT NULL
);
-- The list and the badge: one person's notices in one workspace, newest first. The retention bounds how many there are.
CREATE INDEX idx_inbox_list ON inbox_entries (user_id, workspace_id, id DESC);
-- One unread notice for a person about a subject: telling them again raises that one.
CREATE UNIQUE INDEX uq_inbox_unread_subject ON inbox_entries (user_id, workspace_id, module, kind, subject_id) WHERE read_at IS NULL;
-- The foreign keys' own, and what the sweep reads.
CREATE INDEX idx_inbox_workspace ON inbox_entries (workspace_id);
CREATE INDEX idx_inbox_actor ON inbox_entries (actor_id) WHERE actor_id IS NOT NULL;
CREATE INDEX idx_inbox_created ON inbox_entries (created_at);
CREATE INDEX idx_inbox_read ON inbox_entries (read_at) WHERE read_at IS NOT NULL;
