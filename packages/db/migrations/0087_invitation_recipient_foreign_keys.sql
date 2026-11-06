-- purlay: large-table-ok: Both tables are created by 0086 in this same delivery, before any server can serve their first rows.
-- These tables are introduced in this delivery (0086). Lead every foreign key's child
-- column, including account attribution and recipient deletion, with a usable index.
CREATE INDEX idx_invitation_recipients_creator ON workspace_invitation_recipients (created_by) WHERE created_by IS NOT NULL;
CREATE INDEX idx_invitation_attempts_recipient_parent ON workspace_invitation_mail_attempts (recipient_id);
