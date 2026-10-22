-- 0054_server_audit_log
--
-- The trail of changes to the server's own settings (D-26, D-179 §4.8): who changed which setting, when,
-- and from which session — never the value. `audit_log` is a workspace's trail and its workspace is
-- required; the server's settings belong to no workspace, so they have a trail of their own.
--
--   * Append-only, like `audit_log` (I-9): no `updated_at`, no `deleted_at`; nothing updates or deletes
--     a row of it. The id is the application's UUIDv7.
--   * The actor is SET NULL: what was changed survives who changed it (D-27). The session is SET NULL
--     once it is swept.
--   * `action` names the setting and the change: `server.github_connected`, `server.smtp_disconnected`,
--     `server.sign_up_changed` ... — a stable verb, never derived from input.
--
-- Written by `modules/audit/server-audit.ts`, in the transaction that saves the setting.

CREATE TABLE server_audit_log (
    id            UUID PRIMARY KEY,
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action        VARCHAR(64) NOT NULL,
    session_id    UUID REFERENCES sessions(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT server_audit_log_id_is_uuidv7
        CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);

CREATE INDEX idx_server_audit_log_actor ON server_audit_log (actor_user_id, id DESC)
    WHERE actor_user_id IS NOT NULL;
CREATE INDEX idx_server_audit_log_session ON server_audit_log (session_id)
    WHERE session_id IS NOT NULL;
