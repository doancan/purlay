-- REVIEW DRAFT ONLY. New core migration 0116; not installed/applied.
-- Native users/memberships stay canonical. Controls survive native membership removal,
-- preventing a projected row or directory replay from manufacturing manual admission.
CREATE TABLE workspace_admission_controls (
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    initialized_at TIMESTAMPTZ NOT NULL,
    revision UUID NOT NULL DEFAULT gen_random_uuid(),
    blocked_at TIMESTAMPTZ,
    last_builtin_role user_role NOT NULL,
    last_access_kind TEXT NOT NULL CHECK (last_access_kind IN ('member', 'guest')),
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (workspace_id, user_id),
    CHECK (isfinite(initialized_at) AND isfinite(updated_at)),
    CHECK (blocked_at IS NULL OR isfinite(blocked_at)),
    CHECK (last_access_kind <> 'guest' OR last_builtin_role = 'member')
);
CREATE INDEX idx_workspace_admission_controls_user ON workspace_admission_controls(user_id);

CREATE TABLE workspace_access_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    user_id UUID NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('manual', 'directory')),
    name VARCHAR(128) CHECK (name IS NULL OR (name = btrim(name) AND length(name) > 0)),
    -- Retained exact app-owned directory/plugin resource IDs. No guessed email/username key.
    -- Native integration owns the directory's physical tables and will bind these references.
    directory_id UUID,
    directory_link_reference UUID,
    revision UUID NOT NULL DEFAULT gen_random_uuid(),
    authorization_revision UUID NOT NULL DEFAULT gen_random_uuid(),
    state TEXT NOT NULL CHECK (state IN ('active', 'inactive', 'retired')),
    builtin_role user_role NOT NULL DEFAULT 'member',
    access_kind TEXT NOT NULL CHECK (access_kind IN ('member', 'guest')),
    admitted_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    retired_at TIMESTAMPTZ,
    UNIQUE (workspace_id, id),
    UNIQUE (workspace_id, user_id, id),
    FOREIGN KEY (workspace_id, user_id)
        REFERENCES workspace_admission_controls(workspace_id, user_id) ON DELETE CASCADE,
    CHECK (
        (kind = 'manual' AND directory_id IS NULL AND directory_link_reference IS NULL)
        OR (kind = 'directory' AND directory_id IS NOT NULL AND directory_link_reference IS NOT NULL
            AND builtin_role = 'member' AND access_kind = 'member')
    ),
    CHECK (access_kind <> 'guest' OR builtin_role = 'member'),
    CHECK ((state = 'retired') = (retired_at IS NOT NULL)),
    CHECK (isfinite(admitted_at) AND isfinite(created_at) AND isfinite(updated_at)),
    CHECK (retired_at IS NULL OR isfinite(retired_at))
);
CREATE UNIQUE INDEX idx_workspace_access_sources_manual
    ON workspace_access_sources(workspace_id, user_id) WHERE kind = 'manual' AND state <> 'retired';
CREATE UNIQUE INDEX idx_workspace_access_sources_directory
    ON workspace_access_sources(workspace_id, directory_id, directory_link_reference)
    WHERE kind = 'directory' AND state <> 'retired';
CREATE UNIQUE INDEX idx_workspace_access_sources_directory_user
    ON workspace_access_sources(workspace_id, user_id, directory_id)
    WHERE kind = 'directory' AND state <> 'retired';
CREATE INDEX idx_workspace_access_sources_member ON workspace_access_sources(workspace_id, user_id, state, id);
CREATE INDEX idx_workspace_access_sources_user ON workspace_access_sources(user_id);
CREATE INDEX idx_workspace_access_sources_directory_state ON workspace_access_sources(workspace_id, directory_id, state, id);

CREATE FUNCTION workspace_access_capabilities_valid(capabilities TEXT[]) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT AS $$
    SELECT CASE WHEN array_ndims(capabilities) IS DISTINCT FROM 1 THEN false ELSE
        cardinality(capabilities) BETWEEN 1 AND 5
        AND array_position(capabilities, NULL) IS NULL
        AND capabilities <@ ARRAY[
            'members.invite', 'members.manage_nonowners', 'audit.read',
            'channel.settings.manage', 'channel.members.manage'
        ]::TEXT[]
        AND cardinality(capabilities) = (SELECT count(DISTINCT value) FROM unnest(capabilities) AS value)
        END
$$;

CREATE TABLE workspace_access_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name VARCHAR(64) COLLATE "C" NOT NULL CHECK (name = btrim(name) AND length(name) > 0),
    name_key TEXT COLLATE "C" GENERATED ALWAYS AS (lower(name)) STORED,
    revision UUID NOT NULL DEFAULT gen_random_uuid(),
    capabilities TEXT[] NOT NULL CHECK (workspace_access_capabilities_valid(capabilities)),
    retired_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (workspace_id, id),
    CHECK (isfinite(created_at) AND isfinite(updated_at)),
    CHECK (retired_at IS NULL OR isfinite(retired_at))
);
CREATE UNIQUE INDEX idx_workspace_access_roles_name ON workspace_access_roles(workspace_id, name_key) WHERE retired_at IS NULL;
CREATE INDEX idx_workspace_access_roles_live ON workspace_access_roles(workspace_id, retired_at, id);

CREATE TABLE workspace_access_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('manual', 'directory')),
    name VARCHAR(64) COLLATE "C" NOT NULL CHECK (name = btrim(name) AND length(name) > 0),
    name_key TEXT COLLATE "C" GENERATED ALWAYS AS (lower(name)) STORED,
    directory_id UUID,
    directory_group_reference UUID,
    revision UUID NOT NULL DEFAULT gen_random_uuid(),
    state TEXT NOT NULL CHECK (state IN ('active', 'inactive', 'retired')),
    retired_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (workspace_id, id),
    CHECK (
        (kind = 'manual' AND directory_id IS NULL AND directory_group_reference IS NULL)
        OR (kind = 'directory' AND directory_id IS NOT NULL AND directory_group_reference IS NOT NULL)
    ),
    CHECK ((state = 'retired') = (retired_at IS NOT NULL)),
    CHECK (retired_at IS NULL OR isfinite(retired_at)),
    CHECK (isfinite(created_at) AND isfinite(updated_at))
);
CREATE UNIQUE INDEX idx_workspace_access_groups_manual_name
    ON workspace_access_groups(workspace_id, name_key) WHERE kind = 'manual' AND state <> 'retired';
CREATE UNIQUE INDEX idx_workspace_access_groups_directory
    ON workspace_access_groups(workspace_id, directory_id, directory_group_reference)
    WHERE kind = 'directory' AND state <> 'retired';
CREATE INDEX idx_workspace_access_groups_live ON workspace_access_groups(workspace_id, state, id);

CREATE TABLE workspace_access_group_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    group_id UUID NOT NULL,
    user_id UUID NOT NULL,
    source_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (workspace_id, group_id, user_id, source_id),
    FOREIGN KEY (workspace_id, group_id) REFERENCES workspace_access_groups(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, user_id, source_id) REFERENCES workspace_access_sources(workspace_id, user_id, id) ON DELETE CASCADE,
    CHECK (isfinite(created_at))
);
CREATE INDEX idx_workspace_access_group_members_source ON workspace_access_group_members(workspace_id, user_id, source_id);
CREATE INDEX idx_workspace_access_group_members_user ON workspace_access_group_members(user_id);

CREATE TABLE workspace_access_role_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    role_id UUID NOT NULL,
    source_id UUID,
    group_id UUID,
    revision UUID NOT NULL DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (workspace_id, id),
    FOREIGN KEY (workspace_id, role_id) REFERENCES workspace_access_roles(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, source_id) REFERENCES workspace_access_sources(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, group_id) REFERENCES workspace_access_groups(workspace_id, id) ON DELETE CASCADE,
    CHECK ((source_id IS NOT NULL) <> (group_id IS NOT NULL)),
    CHECK (isfinite(created_at))
);
CREATE UNIQUE INDEX idx_workspace_access_role_grants_source ON workspace_access_role_grants(workspace_id, role_id, source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX idx_workspace_access_role_grants_group ON workspace_access_role_grants(workspace_id, role_id, group_id) WHERE group_id IS NOT NULL;
CREATE INDEX idx_workspace_access_role_grants_by_source ON workspace_access_role_grants(workspace_id, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX idx_workspace_access_role_grants_by_group ON workspace_access_role_grants(workspace_id, group_id) WHERE group_id IS NOT NULL;

-- Canonical native scoped-action projection. Does not grant content or workspace membership.
CREATE TABLE workspace_member_capabilities (
    workspace_id UUID NOT NULL,
    user_id UUID NOT NULL,
    capability TEXT NOT NULL CHECK (capability IN ('members.invite', 'members.manage_nonowners', 'audit.read')),
    projection_revision UUID NOT NULL,
    PRIMARY KEY (workspace_id, user_id, capability),
    FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_members(workspace_id, user_id) ON DELETE CASCADE
);
CREATE INDEX idx_workspace_member_capabilities_user ON workspace_member_capabilities(user_id);

CREATE FUNCTION guard_workspace_admission_control() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.workspace_id, NEW.user_id, NEW.initialized_at)
        IS DISTINCT FROM ROW(OLD.workspace_id, OLD.user_id, OLD.initialized_at) THEN
        RAISE EXCEPTION 'workspace admission identity and initialization are immutable' USING ERRCODE = '23514';
    END IF;
    IF ROW(NEW.blocked_at, NEW.last_builtin_role, NEW.last_access_kind)
        IS DISTINCT FROM ROW(OLD.blocked_at, OLD.last_builtin_role, OLD.last_access_kind)
        AND NEW.revision = OLD.revision THEN
        RAISE EXCEPTION 'workspace admission changes require a new revision' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER workspace_admission_control_guard BEFORE UPDATE ON workspace_admission_controls
    FOR EACH ROW EXECUTE FUNCTION guard_workspace_admission_control();

CREATE FUNCTION guard_workspace_access_source() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.id, NEW.workspace_id, NEW.user_id, NEW.kind, NEW.directory_id, NEW.directory_link_reference, NEW.admitted_at)
        IS DISTINCT FROM ROW(OLD.id, OLD.workspace_id, OLD.user_id, OLD.kind, OLD.directory_id, OLD.directory_link_reference, OLD.admitted_at) THEN
        RAISE EXCEPTION 'workspace source provenance is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.state = 'retired' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'retired workspace sources are terminal' USING ERRCODE = '23514';
    END IF;
    IF ROW(NEW.name, NEW.state, NEW.builtin_role, NEW.access_kind)
        IS DISTINCT FROM ROW(OLD.name, OLD.state, OLD.builtin_role, OLD.access_kind)
        AND NEW.revision = OLD.revision THEN
        RAISE EXCEPTION 'workspace source changes require a new revision' USING ERRCODE = '23514';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NEW.authorization_revision = OLD.authorization_revision THEN
        RAISE EXCEPTION 'workspace source state changes require a new authorization revision' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER workspace_access_source_guard BEFORE UPDATE ON workspace_access_sources
    FOR EACH ROW EXECUTE FUNCTION guard_workspace_access_source();

CREATE FUNCTION guard_workspace_access_group_member() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE source workspace_access_sources%ROWTYPE; access_group workspace_access_groups%ROWTYPE;
BEGIN
    SELECT * INTO source FROM workspace_access_sources
        WHERE workspace_id = NEW.workspace_id AND user_id = NEW.user_id AND id = NEW.source_id;
    SELECT * INTO access_group FROM workspace_access_groups
        WHERE workspace_id = NEW.workspace_id AND id = NEW.group_id;
    IF source.id IS NULL OR access_group.id IS NULL OR source.access_kind <> 'member'
        OR (access_group.kind = 'directory' AND (
            source.kind <> 'directory' OR source.directory_id IS DISTINCT FROM access_group.directory_id
        )) THEN
        RAISE EXCEPTION 'access group members require their exact admitted source' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER workspace_access_group_member_guard BEFORE INSERT OR UPDATE ON workspace_access_group_members
    FOR EACH ROW EXECUTE FUNCTION guard_workspace_access_group_member();

CREATE FUNCTION guard_workspace_access_definition() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.id, NEW.workspace_id, NEW.created_at) IS DISTINCT FROM ROW(OLD.id, OLD.workspace_id, OLD.created_at) THEN
        RAISE EXCEPTION 'workspace access definition identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.retired_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'retired access roles are terminal' USING ERRCODE = '23514';
    END IF;
    IF NEW IS DISTINCT FROM OLD AND NEW.revision = OLD.revision THEN
        RAISE EXCEPTION 'workspace access definition changes require a new revision' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER workspace_access_role_guard BEFORE UPDATE ON workspace_access_roles
    FOR EACH ROW EXECUTE FUNCTION guard_workspace_access_definition();
CREATE FUNCTION guard_workspace_access_group() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.id, NEW.workspace_id, NEW.kind, NEW.directory_id, NEW.directory_group_reference, NEW.created_at)
        IS DISTINCT FROM ROW(OLD.id, OLD.workspace_id, OLD.kind, OLD.directory_id, OLD.directory_group_reference, OLD.created_at)
        OR (OLD.state = 'retired' AND NEW IS DISTINCT FROM OLD) THEN
        RAISE EXCEPTION 'access group provenance and terminal retirement are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW IS DISTINCT FROM OLD AND NEW.revision = OLD.revision THEN
        RAISE EXCEPTION 'access group changes require a new revision' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER workspace_access_group_guard BEFORE UPDATE ON workspace_access_groups
    FOR EACH ROW EXECUTE FUNCTION guard_workspace_access_group();
CREATE FUNCTION guard_workspace_access_role_grant() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.id, NEW.workspace_id, NEW.role_id, NEW.source_id, NEW.group_id, NEW.created_at)
        IS DISTINCT FROM ROW(OLD.id, OLD.workspace_id, OLD.role_id, OLD.source_id, OLD.group_id, OLD.created_at) THEN
        RAISE EXCEPTION 'role grant identity and subject are immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER workspace_access_role_grant_guard BEFORE UPDATE ON workspace_access_role_grants
    FOR EACH ROW EXECUTE FUNCTION guard_workspace_access_role_grant();
