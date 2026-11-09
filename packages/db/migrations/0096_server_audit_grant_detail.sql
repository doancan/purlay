-- What an entry of the server's trail says of a change to a workspace's grants (D-289 §7, D-292): the action names what was done and
-- `target_module` names to which module; these say what it was done from and until when, so that a withdrawal read a month later
-- can be told from the one before it. All are NULL for every other entry, and never words: a state, a time, a flag.
--   module_state_before       what the row said before the write: `on` or `off`; NULL when there was no row (the server's mode decided).
--   module_valid_until        the end the write set; NULL for none, and for a write that removes the row.
--   module_valid_until_before the end the row had before the write; NULL for none.
--   cluster_ready_asserted    true when the operator ran `entitlements:apply --cluster-ready`: their word, which nothing verified,
--                             that every node reads grants. NULL when the write was not made by that command.
ALTER TABLE server_audit_log ADD COLUMN module_state_before text;
ALTER TABLE server_audit_log ADD COLUMN module_valid_until timestamptz;
ALTER TABLE server_audit_log ADD COLUMN module_valid_until_before timestamptz;
ALTER TABLE server_audit_log ADD COLUMN cluster_ready_asserted boolean;
ALTER TABLE server_audit_log ADD CONSTRAINT server_audit_log_module_state_before_known CHECK (module_state_before IN ('on', 'off')) NOT VALID;
ALTER TABLE server_audit_log VALIDATE CONSTRAINT server_audit_log_module_state_before_known;
