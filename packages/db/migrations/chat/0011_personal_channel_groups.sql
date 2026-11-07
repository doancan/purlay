-- chat/0011_personal_channel_groups
-- A person's navigation follows them across devices; no core/legacy table changes (#1198).
CREATE TABLE channel_groups (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL,
    user_id UUID NOT NULL,
    name VARCHAR(64) NOT NULL CHECK (name = btrim(name) AND length(name) > 0),
    name_key TEXT GENERATED ALWAYS AS (lower(name)) STORED,
    collapsed BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (id, user_id),
    CONSTRAINT channel_groups_name_key UNIQUE (workspace_id, user_id, name_key),
    FOREIGN KEY (workspace_id, user_id)
        REFERENCES workspace_members(workspace_id, user_id) ON DELETE CASCADE
);
CREATE INDEX idx_channel_groups_owner_id ON channel_groups(workspace_id, user_id, id);
CREATE INDEX idx_channel_groups_user ON channel_groups(user_id);

CREATE TABLE channel_group_channels (
    channel_id UUID NOT NULL,
    user_id UUID NOT NULL,
    group_id UUID NOT NULL,
    PRIMARY KEY (channel_id, user_id),
    FOREIGN KEY (channel_id, user_id)
        REFERENCES channel_members(channel_id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (group_id, user_id)
        REFERENCES channel_groups(id, user_id) ON DELETE CASCADE
);
CREATE INDEX idx_channel_group_channels_group ON channel_group_channels(group_id, user_id);
CREATE INDEX idx_channel_group_channels_user ON channel_group_channels(user_id);
