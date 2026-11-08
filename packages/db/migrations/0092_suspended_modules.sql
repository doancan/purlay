-- A module the server's administrator stopped at run time (D-296): server-wide, one row per module, whatever the workspace. Every
-- node reads the table through a short cache, so a row takes a module out of every workspace on every node within seconds and
-- without a restart; deleting the row brings it back. `module` has no foreign key and no list of values, as `workspace_modules`
-- has none: a build may not carry the module a row names, and a core table never names a module's (D-250 rule 5). Nothing here
-- deletes a module's data: it stays, and is exported, erased and purged as before.
CREATE TABLE suspended_modules (
  module text PRIMARY KEY CHECK (module ~ '^[a-z][a-z0-9-]{0,31}$'),
  -- The operator's own words for why, shown to the next administrator who looks: never anybody else's.
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 200),
  -- Who wrote it, as a label: 'operator' (the console) or 'cli' (the command).
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 48),
  suspended_by uuid REFERENCES users(id) ON DELETE SET NULL,
  suspended_at timestamptz NOT NULL
);
CREATE INDEX idx_suspended_modules_suspended_by ON suspended_modules (suspended_by) WHERE suspended_by IS NOT NULL;

-- The operator's reason for an entry of the server's trail (`server.module_suspended`, D-296): the one entry that carries words,
-- because the trail is where a suspension is looked up after it has been lifted and the row is gone. NULL for every other entry.
ALTER TABLE server_audit_log ADD COLUMN note text;
ALTER TABLE server_audit_log ADD CONSTRAINT server_audit_log_note_length CHECK (char_length(note) BETWEEN 1 AND 200) NOT VALID;
ALTER TABLE server_audit_log VALIDATE CONSTRAINT server_audit_log_note_length;
