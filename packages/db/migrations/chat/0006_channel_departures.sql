-- chat/0006_channel_departures
--
-- Why a person is no longer in a channel, kept for the person alone (D-264). Leaving and being taken out delete
-- the membership, so nothing said afterwards who had been in the channel or how they went; a socket that was
-- down when the `ACCESS_REVOKED` was sent could only be answered "not found". One row per person and channel,
-- replaced by the next departure; the row's only reader is the refusal of that person's own `SUBSCRIBE`.
-- Additive: a new table, nothing existing changes.
CREATE TABLE channel_departures (
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL CHECK (reason IN ('left', 'removed')),
    departed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX idx_channel_departures_user ON channel_departures(user_id);
