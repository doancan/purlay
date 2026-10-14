-- 0036_incident_responders
--
-- Who is responding to an incident (#487, D-137 §3): people in its channel, at most fifty, and the
-- timeline saying who brought each in or took them off.
--
--   * A responder was a member of the incident's channel when brought in — the service's check, the
--     one writer. Leaving the channel later does not take them off: who responded is a record of
--     the incident, as a message stays its author's (D-137 §3).
--   * The incident is this channel's: the key to `incidents (id, channel_id)`, which this adds.
--   * Its timeline gains the two kinds, the person in `to_value` and nothing in `from_value`: a change
--     from one value to another is still only a status's or a severity's.
--
-- New table, a new unique constraint on a small table, and two CHECKs replaced: one transaction. The
-- CHECK is dropped and added again rather than altered; every row today is of one of the old kinds,
-- which the new one includes.

ALTER TABLE incidents ADD CONSTRAINT incidents_id_channel_key UNIQUE (id, channel_id);

CREATE TABLE incident_responders (
    incident_id  UUID NOT NULL,
    channel_id   UUID NOT NULL,
    user_id      UUID NOT NULL,
    added_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    added_at     TIMESTAMPTZ NOT NULL,

    PRIMARY KEY (incident_id, user_id),
    CONSTRAINT incident_responders_incident_fkey
        FOREIGN KEY (incident_id, channel_id) REFERENCES incidents (id, channel_id)
        ON DELETE CASCADE,
    CONSTRAINT incident_responders_user_fkey
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- Every foreign key indexed (D-89); the primary key serves the incident's.
CREATE INDEX idx_incident_responders_channel ON incident_responders (incident_id, channel_id);
CREATE INDEX idx_incident_responders_user ON incident_responders (user_id);
CREATE INDEX idx_incident_responders_added_by ON incident_responders (added_by);

ALTER TABLE incident_updates DROP CONSTRAINT incident_updates_kind_known;
ALTER TABLE incident_updates ADD CONSTRAINT incident_updates_kind_known CHECK (
    kind IN ('declared', 'status', 'severity', 'responder_added', 'responder_removed')
);
ALTER TABLE incident_updates DROP CONSTRAINT incident_updates_from;
ALTER TABLE incident_updates ADD CONSTRAINT incident_updates_from
    CHECK ((kind IN ('status', 'severity')) = (from_value IS NOT NULL));
