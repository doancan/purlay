-- Workspace directory provisioning uses the pinned native SCIM resources, not a second account authority.
CREATE TABLE workspace_directories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    connection_id UUID NOT NULL,
    claim TEXT NOT NULL CHECK (claim IN ('sub', 'oid')),
    name VARCHAR(64) COLLATE "C" NOT NULL CHECK (name = btrim(name) AND length(name) > 0),
    revision UUID NOT NULL DEFAULT gen_random_uuid(),
    authorization_revision UUID NOT NULL DEFAULT gen_random_uuid(),
    enabled BOOLEAN NOT NULL DEFAULT false,
    allow_create BOOLEAN NOT NULL DEFAULT false,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, id),
    FOREIGN KEY (workspace_id, connection_id)
        REFERENCES workspace_identity_connections(workspace_id, id) ON DELETE CASCADE,
    CHECK (NOT enabled OR deleted_at IS NULL)
);
CREATE UNIQUE INDEX idx_workspace_directories_connection ON workspace_directories(connection_id);
CREATE UNIQUE INDEX idx_workspace_directories_name ON workspace_directories(workspace_id, name) WHERE deleted_at IS NULL;
CREATE INDEX idx_workspace_directories_live ON workspace_directories(workspace_id, deleted_at, id);

CREATE TABLE workspace_directory_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    directory_id UUID NOT NULL,
    token_hash TEXT COLLATE "C" NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (workspace_id, directory_id) REFERENCES workspace_directories(workspace_id, id) ON DELETE CASCADE,
    CHECK (isfinite(created_at) AND isfinite(expires_at) AND expires_at > created_at
        AND expires_at <= created_at + interval '365 days')
);
CREATE INDEX idx_workspace_directory_credentials_live ON workspace_directory_credentials(directory_id, revoked_at, expires_at);

-- Existing people consent through an exact signed company link. New people are initialized once
-- through a native, transaction-bound directory admission capability; neither path guesses email.
CREATE TABLE workspace_directory_identity_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    directory_id UUID NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    external_id TEXT COLLATE "C" NOT NULL CHECK (length(external_id) BETWEEN 1 AND 255),
    origin TEXT NOT NULL CHECK (origin IN ('company_link', 'directory_created')),
    binding_reference UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (workspace_id, directory_id) REFERENCES workspace_directories(workspace_id, id) ON DELETE CASCADE,
    UNIQUE (directory_id, external_id),
    UNIQUE (directory_id, user_id),
    CHECK ((origin = 'company_link' AND binding_reference IS NOT NULL)
        OR (origin = 'directory_created' AND binding_reference IS NULL))
);
CREATE INDEX idx_workspace_directory_identity_links_user ON workspace_directory_identity_links(user_id);

-- Retained classification must not become manual when a directory or its source disappears.
ALTER TABLE workspace_identity_connections
    ADD COLUMN directory_id UUID,
    ADD COLUMN directory_claim TEXT,
    ADD CONSTRAINT workspace_identity_connections_directory_pair CHECK (
        (directory_id IS NULL AND directory_claim IS NULL)
        OR (directory_id IS NOT NULL AND directory_claim IS NOT NULL AND directory_claim IN ('sub', 'oid'))
    ) NOT VALID,
    ADD CONSTRAINT workspace_identity_connections_directory_reference FOREIGN KEY (workspace_id, directory_id)
        REFERENCES workspace_directories(workspace_id, id) NOT VALID;
ALTER TABLE sessions ADD COLUMN directory_id UUID,
    ADD CONSTRAINT sessions_directory_company CHECK (directory_id IS NULL OR company_workspace_id IS NOT NULL) NOT VALID;
ALTER TABLE native_authorizations ADD COLUMN directory_id UUID,
    ADD CONSTRAINT native_authorizations_directory_company CHECK (directory_id IS NULL OR
        (company_workspace_id IS NOT NULL AND company_source_session_id IS NOT NULL)) NOT VALID;
ALTER TABLE workspace_identity_sessions
    ADD COLUMN directory_id UUID,
    ADD COLUMN directory_link_reference UUID,
    ADD COLUMN directory_authorization_revision UUID,
    ADD COLUMN source_id UUID,
    ADD COLUMN source_authorization_revision UUID,
    ADD COLUMN admission_revision UUID,
    ADD CONSTRAINT workspace_identity_sessions_directory_tuple CHECK (
        (directory_id IS NULL AND directory_link_reference IS NULL AND directory_authorization_revision IS NULL
            AND source_id IS NULL AND source_authorization_revision IS NULL AND admission_revision IS NULL)
        OR (directory_id IS NOT NULL AND directory_link_reference IS NOT NULL AND directory_authorization_revision IS NOT NULL
            AND source_id IS NOT NULL AND source_authorization_revision IS NOT NULL AND admission_revision IS NOT NULL)
    ) NOT VALID;
COMMENT ON COLUMN workspace_identity_sessions.admission_revision IS
    'Diagnostic projection revision, not a global authentication epoch. Liveness requires exact issuing source authorization, directory revision and an unblocked retained control.';

CREATE FUNCTION retain_directory_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME = 'workspace_directories' THEN
        IF (NEW.id, NEW.workspace_id, NEW.connection_id, NEW.claim, NEW.created_at)
            IS DISTINCT FROM (OLD.id, OLD.workspace_id, OLD.connection_id, OLD.claim, OLD.created_at) THEN
            RAISE EXCEPTION 'directory identity is immutable';
        END IF;
        IF OLD.deleted_at IS NOT NULL AND (NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NEW.enabled) THEN
            RAISE EXCEPTION 'directory deletion is terminal';
        END IF;
        IF (NEW.enabled, NEW.deleted_at) IS DISTINCT FROM (OLD.enabled, OLD.deleted_at) THEN
            NEW.authorization_revision := gen_random_uuid();
        ELSIF NEW.authorization_revision IS DISTINCT FROM OLD.authorization_revision THEN
            RAISE EXCEPTION 'directory authorization revision changes only with security state';
        END IF;
    ELSIF TG_TABLE_NAME = 'workspace_directory_credentials' THEN
        IF (NEW.id, NEW.workspace_id, NEW.directory_id, NEW.token_hash, NEW.created_at)
            IS DISTINCT FROM (OLD.id, OLD.workspace_id, OLD.directory_id, OLD.token_hash, OLD.created_at)
            OR NEW.expires_at > OLD.expires_at THEN
            RAISE EXCEPTION 'directory credential identity and lifetime are immutable';
        END IF;
        IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
            RAISE EXCEPTION 'directory credential revocation is terminal';
        END IF;
        IF OLD.last_used_at IS NOT NULL AND (NEW.last_used_at IS NULL OR NEW.last_used_at < OLD.last_used_at) THEN
            RAISE EXCEPTION 'directory credential activity cannot move backwards';
        END IF;
    ELSIF TG_TABLE_NAME = 'workspace_directory_identity_links' THEN
        IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'directory canonical link is immutable'; END IF;
    ELSIF TG_TABLE_NAME = 'workspace_identity_connections' THEN
        IF OLD.directory_id IS NOT NULL AND (NEW.directory_id, NEW.directory_claim)
            IS DISTINCT FROM (OLD.directory_id, OLD.directory_claim) THEN
            RAISE EXCEPTION 'directory connection classification is retained';
        END IF;
    ELSIF TG_TABLE_NAME IN ('sessions', 'native_authorizations') THEN
        IF OLD.directory_id IS NOT NULL AND (NEW.directory_id, NEW.company_workspace_id)
            IS DISTINCT FROM (OLD.directory_id, OLD.company_workspace_id) THEN
            RAISE EXCEPTION 'native directory origin is retained';
        END IF;
    ELSIF TG_TABLE_NAME = 'workspace_identity_sessions' THEN
        IF (NEW.directory_id, NEW.directory_link_reference, NEW.directory_authorization_revision,
            NEW.source_id, NEW.source_authorization_revision, NEW.admission_revision)
            IS DISTINCT FROM (OLD.directory_id, OLD.directory_link_reference, OLD.directory_authorization_revision,
            OLD.source_id, OLD.source_authorization_revision, OLD.admission_revision) THEN
            RAISE EXCEPTION 'native directory proof is immutable';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_directories_identity BEFORE UPDATE ON workspace_directories FOR EACH ROW EXECUTE FUNCTION retain_directory_identity();
CREATE TRIGGER workspace_directory_credentials_identity BEFORE UPDATE ON workspace_directory_credentials FOR EACH ROW EXECUTE FUNCTION retain_directory_identity();
CREATE TRIGGER workspace_directory_links_identity BEFORE UPDATE ON workspace_directory_identity_links FOR EACH ROW EXECUTE FUNCTION retain_directory_identity();
CREATE TRIGGER workspace_identity_connection_directory BEFORE UPDATE ON workspace_identity_connections FOR EACH ROW EXECUTE FUNCTION retain_directory_identity();
CREATE TRIGGER sessions_directory_origin BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION retain_directory_identity();
CREATE TRIGGER native_authorizations_directory_origin BEFORE UPDATE ON native_authorizations FOR EACH ROW EXECUTE FUNCTION retain_directory_identity();
CREATE TRIGGER workspace_identity_sessions_directory BEFORE UPDATE ON workspace_identity_sessions FOR EACH ROW EXECUTE FUNCTION retain_directory_identity();

-- Exact native @better-auth/scim1.7.14 schema, compiled read-only through its public SDK migrator.
create table "workspace_directory_scim_bindings" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "connection_id" text COLLATE "C" not null, "connection_key" text COLLATE "C" not null unique, "provisioning_domain_id" text COLLATE "C" not null, "created_at" timestamptz not null, "decommissioned_at" timestamptz, "decommission_status" text not null, "decommission_cursor_user_id" text COLLATE "C", "decommission_reconciled_user_count" integer not null, "decommission_batch_count" integer not null, "decommission_revision" integer not null, "decommission_completed_at" timestamptz, "decommission_lease_id" text COLLATE "C", "decommission_lease_expires_at" timestamptz);

create table "workspace_directory_scim_tombstones" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "connection_id" text COLLATE "C" not null, "provisioning_domain_id" text COLLATE "C" not null, "external_id" text COLLATE "C" not null, "external_id_key" text COLLATE "C" not null unique, "user_id" uuid not null references "users" ("id") on delete cascade, "profile" text not null, "deleted_at" timestamptz not null);

create table "workspace_directory_scim_subjects" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "user_id" uuid not null unique references "users" ("id") on delete cascade, "profile_source_id" text COLLATE "C", "revision" integer not null, "created_at" timestamptz not null, "updated_at" timestamptz not null);

create table "workspace_directory_scim_users" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "connection_id" text COLLATE "C" not null, "provisioning_domain_id" text COLLATE "C" not null, "user_id" uuid not null references "users" ("id") on delete cascade, "connection_user_key" text COLLATE "C" not null unique, "user_name" text not null, "user_name_key" text COLLATE "C" not null unique, "primary_email" text not null, "work_email_value_index" text COLLATE "C" not null, "email_value_index" text COLLATE "C" not null, "display_name" text not null, "formatted_name" text not null, "given_name" text, "family_name" text, "serialized_emails" text not null, "serialized_attributes" text, "external_id" text COLLATE "C", "external_id_key" text COLLATE "C" unique, "active" boolean not null, "order_key" text COLLATE "C" not null unique, "created_at" timestamptz not null, "updated_at" timestamptz not null);

create table "workspace_directory_scim_grants" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "connection_id" text COLLATE "C" not null, "provisioning_domain_id" text COLLATE "C" not null, "scim_user_id" uuid not null references "workspace_directory_scim_users" ("id") on delete cascade, "user_id" uuid not null references "users" ("id") on delete cascade, "source_kind" text COLLATE "C" not null, "source_id" text COLLATE "C" not null, "source_value" text COLLATE "C", "role" text COLLATE "C" not null, "grant_key" text COLLATE "C" not null unique, "created_at" timestamptz not null, "updated_at" timestamptz not null);

create table "workspace_directory_scim_groups" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "connection_id" text COLLATE "C" not null, "provisioning_domain_id" text COLLATE "C" not null, "revision" integer not null, "display_name" text not null, "display_name_key" text COLLATE "C" not null unique, "external_id" text COLLATE "C", "external_id_key" text COLLATE "C" unique, "order_key" text COLLATE "C" not null unique, "created_at" timestamptz not null, "updated_at" timestamptz not null);

create table "workspace_directory_scim_group_members" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "connection_id" text COLLATE "C" not null, "group_id" uuid not null references "workspace_directory_scim_groups" ("id") on delete cascade, "scim_user_id" uuid not null references "workspace_directory_scim_users" ("id") on delete cascade, "membership_key" text COLLATE "C" not null unique, "created_at" timestamptz not null);

create index "workspace_directory_scim_bindings_connection_id_idx" on "workspace_directory_scim_bindings" ("connection_id");

create index "workspace_directory_scim_tombstones_connection_id_idx" on "workspace_directory_scim_tombstones" ("connection_id");

create index "workspace_directory_scim_tombstones_provisioning_domain_id_idx" on "workspace_directory_scim_tombstones" ("provisioning_domain_id");

create index "workspace_directory_scim_tombstones_user_id_idx" on "workspace_directory_scim_tombstones" ("user_id");

create index "workspace_directory_scim_subjects_profile_source_id_idx" on "workspace_directory_scim_subjects" ("profile_source_id");

create index "workspace_directory_scim_users_connection_id_idx" on "workspace_directory_scim_users" ("connection_id");

create index "workspace_directory_scim_users_provisioning_domain_id_idx" on "workspace_directory_scim_users" ("provisioning_domain_id");

create index "workspace_directory_scim_users_user_id_idx" on "workspace_directory_scim_users" ("user_id");

create index "workspace_directory_scim_grants_connection_id_idx" on "workspace_directory_scim_grants" ("connection_id");

create index "workspace_directory_scim_grants_provisioning_domain_id_idx" on "workspace_directory_scim_grants" ("provisioning_domain_id");

create index "workspace_directory_scim_grants_scim_user_id_idx" on "workspace_directory_scim_grants" ("scim_user_id");

create index "workspace_directory_scim_grants_user_id_idx" on "workspace_directory_scim_grants" ("user_id");

create index "workspace_directory_scim_groups_connection_id_idx" on "workspace_directory_scim_groups" ("connection_id");

create index "workspace_directory_scim_groups_provisioning_domain_id_idx" on "workspace_directory_scim_groups" ("provisioning_domain_id");

create index "workspace_directory_scim_group_members_connection_id_idx" on "workspace_directory_scim_group_members" ("connection_id");

create index "workspace_directory_scim_group_members_group_id_idx" on "workspace_directory_scim_group_members" ("group_id");

create index "workspace_directory_scim_group_members_scim_user_id_idx" on "workspace_directory_scim_group_members" ("scim_user_id");
