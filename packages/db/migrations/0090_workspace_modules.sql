-- Which of the build's modules one workspace may use (D-289): the operator's grant, one row per workspace and module.
-- `module` has no foreign key and no list of values: a build may not carry the module a row names, and a core table never
-- names a module's (D-250 rule 5). A workspace with no row for a module takes the server's mode (`WORKSPACE_MODULES`):
-- `open` is on, `managed` is off. `off` closes a module for a workspace in `open`, `on` opens it in `managed`. A grant past
-- `valid_until` is read as no row at all. Nothing here deletes a module's data: it hides it.
CREATE TABLE workspace_modules (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  module text NOT NULL CHECK (module ~ '^[a-z][a-z0-9-]{0,31}$'),
  state text NOT NULL CHECK (state IN ('on', 'off')),
  valid_until timestamptz,
  -- Who wrote it, as a label: 'operator' (the administrator's console), 'file:<name>' (the edition file) or a billing system's.
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 48),
  changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, module)
);
-- The key of a membership read starts with the workspace, so the read of a workspace's rows needs no index of its own;
-- this one is the foreign key to the person who wrote the row.
CREATE INDEX idx_workspace_modules_changed_by ON workspace_modules (changed_by) WHERE changed_by IS NOT NULL;

-- The module an entry of the server's trail is about (`server.module_granted` and its kin, D-289), by id and never by words:
-- the action says what was done, the workspace and this column say to what. NULL for every other entry; text with no key, as
-- `workspace_modules.module` is, and no index, because the trail is read by action and by workspace.
ALTER TABLE server_audit_log ADD COLUMN target_module text;
ALTER TABLE server_audit_log ADD CONSTRAINT server_audit_log_target_module_shape CHECK (target_module ~ '^[a-z][a-z0-9-]{0,31}$') NOT VALID;
ALTER TABLE server_audit_log VALIDATE CONSTRAINT server_audit_log_target_module_shape;
