-- Recipient evidence is private to workspace managers. Bearer tokens and message bodies never live here.
CREATE TABLE workspace_invitation_recipients (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email text NOT NULL,
  locale text NOT NULL CHECK (locale IN ('en', 'tr')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  applicant_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_at timestamptz,
  joined_at timestamptz,
  UNIQUE (id, workspace_id)
);
CREATE INDEX idx_invitation_recipients_workspace ON workspace_invitation_recipients (workspace_id, id DESC);
CREATE INDEX idx_invitation_recipients_email ON workspace_invitation_recipients (email);
CREATE INDEX idx_invitation_recipients_applicant ON workspace_invitation_recipients (applicant_user_id) WHERE applicant_user_id IS NOT NULL;
CREATE TABLE workspace_invitation_mail_attempts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL,
  invitation_id uuid NOT NULL UNIQUE REFERENCES workspace_invitations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  result text NOT NULL CHECK (result IN ('queued', 'accepted', 'failed')),
  finished_at timestamptz,
  failure text CHECK (failure IN ('connection', 'authentication', 'recipient', 'message', 'tls', 'unknown')),
  FOREIGN KEY (recipient_id, workspace_id) REFERENCES workspace_invitation_recipients(id, workspace_id) ON DELETE CASCADE,
  CHECK ((result = 'queued' AND finished_at IS NULL AND failure IS NULL)
      OR (result = 'accepted' AND finished_at IS NOT NULL AND failure IS NULL)
      OR (result = 'failed' AND finished_at IS NOT NULL AND failure IS NOT NULL))
);
CREATE INDEX idx_invitation_attempts_recipient ON workspace_invitation_mail_attempts (workspace_id, recipient_id, id DESC);
