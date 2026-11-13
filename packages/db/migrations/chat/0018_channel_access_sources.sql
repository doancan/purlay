-- REVIEW DRAFT ONLY. New chat migration 0018; not installed/applied.
-- Every key points chat -> chat/core, never core -> chat.
-- Existing UNIQUE(id, workspace_id) from0010 already covers the referenced column set.
-- No redundant blocking index/ALTER is needed.

-- Retained per-channel initialization prevents lazy adoption of an already projected row.
CREATE TABLE channel_access_controls (
    workspace_id UUID NOT NULL,
    channel_id UUID NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    initialized_at TIMESTAMPTZ NOT NULL,
    revision UUID NOT NULL DEFAULT gen_random_uuid(),
    PRIMARY KEY (channel_id, user_id),
    UNIQUE (workspace_id, channel_id, user_id),
    FOREIGN KEY (workspace_id, channel_id) REFERENCES channels(workspace_id, id) ON DELETE CASCADE,
    CHECK (isfinite(initialized_at))
);
CREATE INDEX idx_channel_access_controls_user ON channel_access_controls(user_id);
CREATE INDEX idx_channel_access_controls_workspace ON channel_access_controls(workspace_id, user_id);

CREATE TABLE channel_access_group_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    channel_id UUID NOT NULL,
    group_id UUID NOT NULL,
    revision UUID NOT NULL DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (workspace_id, id),
    UNIQUE (workspace_id, channel_id, group_id),
    FOREIGN KEY (workspace_id, channel_id) REFERENCES channels(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, group_id) REFERENCES workspace_access_groups(workspace_id, id) ON DELETE CASCADE,
    CHECK (isfinite(created_at))
);
CREATE INDEX idx_channel_access_group_mappings_group ON channel_access_group_mappings(workspace_id, group_id);

CREATE TABLE channel_access_member_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    channel_id UUID NOT NULL,
    user_id UUID NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('manual', 'source', 'group')),
    source_id UUID,
    group_id UUID,
    revision UUID NOT NULL DEFAULT gen_random_uuid(),
    admitted_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (workspace_id, id),
    FOREIGN KEY (workspace_id, channel_id, user_id)
        REFERENCES channel_access_controls(workspace_id, channel_id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, user_id, source_id)
        REFERENCES workspace_access_sources(workspace_id, user_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, channel_id, group_id)
        REFERENCES channel_access_group_mappings(workspace_id, channel_id, group_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, group_id, user_id, source_id)
        REFERENCES workspace_access_group_members(workspace_id, group_id, user_id, source_id) ON DELETE CASCADE,
    CHECK (
        (kind = 'manual' AND source_id IS NULL AND group_id IS NULL)
        OR (kind = 'source' AND source_id IS NOT NULL AND group_id IS NULL)
        OR (kind = 'group' AND source_id IS NOT NULL AND group_id IS NOT NULL)
    ),
    CHECK (isfinite(admitted_at) AND isfinite(created_at))
);
CREATE UNIQUE INDEX idx_channel_access_member_grants_manual ON channel_access_member_grants(channel_id, user_id) WHERE kind = 'manual';
CREATE UNIQUE INDEX idx_channel_access_member_grants_source ON channel_access_member_grants(channel_id, user_id, source_id) WHERE kind = 'source';
CREATE UNIQUE INDEX idx_channel_access_member_grants_group ON channel_access_member_grants(channel_id, user_id, source_id, group_id) WHERE kind = 'group';
CREATE INDEX idx_channel_access_member_grants_user ON channel_access_member_grants(user_id);
CREATE INDEX idx_channel_access_member_grants_source_member ON channel_access_member_grants(workspace_id, user_id, source_id);
CREATE INDEX idx_channel_access_member_grants_group_mapping ON channel_access_member_grants(workspace_id, channel_id, group_id);
CREATE INDEX idx_channel_access_member_grants_group_member ON channel_access_member_grants(workspace_id, group_id, user_id, source_id);

CREATE TABLE channel_access_role_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    channel_id UUID NOT NULL,
    role_id UUID NOT NULL,
    source_id UUID,
    group_id UUID,
    revision UUID NOT NULL DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (workspace_id, id),
    FOREIGN KEY (workspace_id, channel_id) REFERENCES channels(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, role_id) REFERENCES workspace_access_roles(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, source_id) REFERENCES workspace_access_sources(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, group_id) REFERENCES workspace_access_groups(workspace_id, id) ON DELETE CASCADE,
    CHECK ((source_id IS NOT NULL) <> (group_id IS NOT NULL)),
    CHECK (isfinite(created_at))
);
CREATE UNIQUE INDEX idx_channel_access_role_grants_source ON channel_access_role_grants(channel_id, role_id, source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX idx_channel_access_role_grants_group ON channel_access_role_grants(channel_id, role_id, group_id) WHERE group_id IS NOT NULL;
CREATE INDEX idx_channel_access_role_grants_role ON channel_access_role_grants(workspace_id, role_id);
CREATE INDEX idx_channel_access_role_grants_source_lookup ON channel_access_role_grants(workspace_id, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX idx_channel_access_role_grants_group_lookup ON channel_access_role_grants(workspace_id, group_id) WHERE group_id IS NOT NULL;
CREATE INDEX idx_channel_access_role_grants_workspace_channel ON channel_access_role_grants(workspace_id, channel_id);

-- Management capability never creates channel membership or private content visibility.
CREATE TABLE channel_member_capabilities (
    workspace_id UUID NOT NULL,
    channel_id UUID NOT NULL,
    user_id UUID NOT NULL,
    capability TEXT NOT NULL CHECK (capability IN ('channel.settings.manage', 'channel.members.manage')),
    projection_revision UUID NOT NULL,
    PRIMARY KEY (channel_id, user_id, capability),
    FOREIGN KEY (workspace_id, channel_id) REFERENCES channels(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (channel_id, user_id) REFERENCES channel_members(channel_id, user_id) ON DELETE CASCADE
);
CREATE INDEX idx_channel_member_capabilities_user ON channel_member_capabilities(user_id);
CREATE INDEX idx_channel_member_capabilities_workspace_member ON channel_member_capabilities(workspace_id, user_id);

CREATE FUNCTION guard_channel_access_control() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.workspace_id, NEW.channel_id, NEW.user_id, NEW.initialized_at)
        IS DISTINCT FROM ROW(OLD.workspace_id, OLD.channel_id, OLD.user_id, OLD.initialized_at) THEN
        RAISE EXCEPTION 'channel access initialization is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER channel_access_control_guard BEFORE UPDATE ON channel_access_controls
    FOR EACH ROW EXECUTE FUNCTION guard_channel_access_control();

CREATE FUNCTION guard_channel_access_scope() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE channel_kind channel_type;
BEGIN
    SELECT type INTO channel_kind FROM channels WHERE workspace_id = NEW.workspace_id AND id = NEW.channel_id;
    IF channel_kind IS NULL OR channel_kind = 'direct_message' THEN
        RAISE EXCEPTION 'directory and role scope requires an exact non-DM channel' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER channel_access_group_mapping_scope BEFORE INSERT OR UPDATE ON channel_access_group_mappings
    FOR EACH ROW EXECUTE FUNCTION guard_channel_access_scope();
CREATE TRIGGER channel_access_role_grant_scope BEFORE INSERT OR UPDATE ON channel_access_role_grants
    FOR EACH ROW EXECUTE FUNCTION guard_channel_access_scope();
CREATE TRIGGER channel_member_capability_scope BEFORE INSERT OR UPDATE ON channel_member_capabilities
    FOR EACH ROW EXECUTE FUNCTION guard_channel_access_scope();

CREATE FUNCTION guard_channel_access_member_grant() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE channel_kind channel_type;
BEGIN
    SELECT type INTO channel_kind FROM channels WHERE workspace_id = NEW.workspace_id AND id = NEW.channel_id;
    -- Ordinary native DM participants are manual; directory/group grants never change its audience.
    IF channel_kind IS NULL OR (channel_kind = 'direct_message' AND NEW.kind <> 'manual') THEN
        RAISE EXCEPTION 'directory channel grants cannot change a direct message audience' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND ROW(NEW.id, NEW.workspace_id, NEW.channel_id, NEW.user_id, NEW.kind, NEW.source_id, NEW.group_id, NEW.admitted_at, NEW.created_at)
        IS DISTINCT FROM ROW(OLD.id, OLD.workspace_id, OLD.channel_id, OLD.user_id, OLD.kind, OLD.source_id, OLD.group_id, OLD.admitted_at, OLD.created_at) THEN
        RAISE EXCEPTION 'channel grant provenance is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER channel_access_member_grant_guard BEFORE INSERT OR UPDATE ON channel_access_member_grants
    FOR EACH ROW EXECUTE FUNCTION guard_channel_access_member_grant();
CREATE FUNCTION guard_channel_access_mapping() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.id, NEW.workspace_id, NEW.channel_id, NEW.group_id, NEW.created_at)
        IS DISTINCT FROM ROW(OLD.id, OLD.workspace_id, OLD.channel_id, OLD.group_id, OLD.created_at) THEN
        RAISE EXCEPTION 'channel group mapping identity is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER channel_access_group_mapping_guard BEFORE UPDATE ON channel_access_group_mappings
    FOR EACH ROW EXECUTE FUNCTION guard_channel_access_mapping();
CREATE FUNCTION guard_channel_access_role_grant() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.id, NEW.workspace_id, NEW.channel_id, NEW.role_id, NEW.source_id, NEW.group_id, NEW.created_at)
        IS DISTINCT FROM ROW(OLD.id, OLD.workspace_id, OLD.channel_id, OLD.role_id, OLD.source_id, OLD.group_id, OLD.created_at) THEN
        RAISE EXCEPTION 'channel role grant identity is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER channel_access_role_grant_guard BEFORE UPDATE ON channel_access_role_grants
    FOR EACH ROW EXECUTE FUNCTION guard_channel_access_role_grant();
