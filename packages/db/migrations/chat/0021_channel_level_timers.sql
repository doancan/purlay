-- chat/0021_channel_level_timers
-- A notification level chosen for a while (D-329): when it ends and the level it gives way to. In chat's own table,
-- beside the membership it times, as the read scopes are (chat/0010). The level in force is read against the clock,
-- so nothing has to run when it ends, and a row past its end is only history. Additive: no row means no timer.
CREATE TABLE channel_level_timers (
    channel_id UUID NOT NULL,
    user_id UUID NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    then_level notification_level NOT NULL,
    PRIMARY KEY (channel_id, user_id),
    FOREIGN KEY (channel_id, user_id)
        REFERENCES channel_members(channel_id, user_id) ON DELETE CASCADE
);
CREATE INDEX idx_channel_level_timers_user ON channel_level_timers(user_id);
