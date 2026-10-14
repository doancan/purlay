-- 0035_incidents
--
-- A channel's incidents (#487, D-137): an incident is a state of a channel, not a kind of channel —
-- declared in it, moved between investigating and mitigating, resolved once.
--
--   * Its id is the client's UUIDv7, the message-id rule (D-33): a declaration retried after a lost
--     answer finds the incident it made.
--   * The channel is in this workspace (I-1, I-4): the composite key `pinned_messages` has, so an
--     incident cannot point across a tenant.
--   * **One open incident a channel**: a partial unique index, so two declarations racing cannot both
--     open one. A resolved incident stays, and declaring again opens another.
--   * Resolved is a state with its instant: the two are one fact (`incidents_resolved_at`).
--   * `declared_by` and an update's `actor_id` outlive their person as NULL: what happened is the
--     channel's, not theirs. Erasure keeps the user row (I-11), so this is for a row hard-deleted.
--   * Its timeline, `incident_updates`, is append-only: what changed, from what to what, by whom and
--     when, keyset on its UUIDv7 id. Never updated; it goes with its incident.
--
-- New tables with no rows: one transaction, as 0026.

CREATE TABLE incidents (
    id            UUID PRIMARY KEY,
    channel_id    UUID NOT NULL,
    workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    severity      SMALLINT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'investigating',
    declared_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    declared_at   TIMESTAMPTZ NOT NULL,
    resolved_at   TIMESTAMPTZ,

    CONSTRAINT incidents_severity_known CHECK (severity BETWEEN 1 AND 4),
    CONSTRAINT incidents_status_known
        CHECK (status IN ('investigating', 'mitigating', 'resolved')),
    CONSTRAINT incidents_resolved_at CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
    CONSTRAINT incidents_id_is_uuidv7
        CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    CONSTRAINT incidents_channel_workspace_fkey
        FOREIGN KEY (channel_id, workspace_id) REFERENCES channels (id, workspace_id)
        ON DELETE CASCADE
);

-- At most one open incident a channel; also how a channel's open one is found, for its list.
CREATE UNIQUE INDEX idx_incidents_one_open ON incidents (channel_id) WHERE resolved_at IS NULL;
-- A channel's incidents, latest first: the one shown once none is open.
CREATE INDEX idx_incidents_channel ON incidents (channel_id, declared_at DESC);
-- Every foreign key indexed (D-89).
CREATE INDEX idx_incidents_channel_workspace ON incidents (channel_id, workspace_id);
CREATE INDEX idx_incidents_workspace ON incidents (workspace_id);
CREATE INDEX idx_incidents_declared_by ON incidents (declared_by);

CREATE TABLE incident_updates (
    id           UUID PRIMARY KEY,
    incident_id  UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,
    from_value   TEXT,
    to_value     TEXT NOT NULL,
    actor_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    at           TIMESTAMPTZ NOT NULL,

    CONSTRAINT incident_updates_kind_known CHECK (kind IN ('declared', 'status', 'severity')),
    -- A declaration starts from nothing; a change is from one value to another.
    CONSTRAINT incident_updates_from CHECK ((kind = 'declared') = (from_value IS NULL)),
    CONSTRAINT incident_updates_id_is_uuidv7
        CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);

-- An incident's timeline, newest first: what it pages through.
CREATE INDEX idx_incident_updates_incident ON incident_updates (incident_id, id DESC);
CREATE INDEX idx_incident_updates_actor ON incident_updates (actor_id);
