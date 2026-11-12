-- Workspace-owned company identity, without another user or membership authority (D-308).
CREATE TABLE workspace_identity_domains (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    domain TEXT COLLATE "C" NOT NULL CHECK (
        length(domain) BETWEEN 1 AND 253 AND domain = lower(domain) AND domain = btrim(domain)
    ),
    revision UUID NOT NULL DEFAULT gen_random_uuid(),
    challenge_digest TEXT CHECK (challenge_digest ~ '^[0-9a-f]{64}$'),
    challenge_encrypted BYTEA,
    challenge_issued_at TIMESTAMPTZ NOT NULL,
    challenge_expires_at TIMESTAMPTZ NOT NULL,
    verified_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, id),
    CHECK ((challenge_digest IS NULL) = (challenge_encrypted IS NULL)),
    CHECK (verified_at IS NOT NULL OR revoked_at IS NOT NULL OR challenge_digest IS NOT NULL),
    CHECK (
        isfinite(challenge_issued_at) AND isfinite(challenge_expires_at)
        AND challenge_expires_at > challenge_issued_at
        AND challenge_expires_at <= challenge_issued_at + interval '1 day'
    )
);
CREATE UNIQUE INDEX idx_workspace_identity_domain_name
    ON workspace_identity_domains (workspace_id, domain) WHERE revoked_at IS NULL;
CREATE INDEX idx_workspace_identity_domains_live
    ON workspace_identity_domains (workspace_id, revoked_at, id);

CREATE TABLE workspace_identity_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    domain_id UUID NOT NULL,
    name VARCHAR(40) NOT NULL CHECK (name = btrim(name) AND length(name) > 0),
    issuer TEXT COLLATE "C" NOT NULL CHECK (length(issuer) BETWEEN 1 AND 512),
    client_id TEXT NOT NULL CHECK (length(client_id) BETWEEN 1 AND 256),
    client_secret_encrypted BYTEA,
    revision UUID NOT NULL DEFAULT gen_random_uuid(),
    authentication_revision UUID NOT NULL DEFAULT gen_random_uuid(),
    tested_authentication_revision UUID,
    tested_at TIMESTAMPTZ,
    enabled BOOLEAN NOT NULL DEFAULT false,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, id),
    FOREIGN KEY (workspace_id, domain_id)
        REFERENCES workspace_identity_domains(workspace_id, id) ON DELETE CASCADE,
    CHECK (client_secret_encrypted IS NOT NULL OR deleted_at IS NOT NULL),
    CHECK ((tested_authentication_revision IS NULL) = (tested_at IS NULL)),
    CHECK (NOT enabled OR (
        deleted_at IS NULL AND client_secret_encrypted IS NOT NULL
        AND tested_authentication_revision IS NOT NULL
        AND tested_authentication_revision = authentication_revision
    ))
);
CREATE UNIQUE INDEX idx_workspace_identity_connection_name
    ON workspace_identity_connections (workspace_id, name) WHERE deleted_at IS NULL;
CREATE INDEX idx_workspace_identity_connections_live
    ON workspace_identity_connections (workspace_id, deleted_at, id);
CREATE INDEX idx_workspace_identity_connections_domain
    ON workspace_identity_connections (workspace_id, domain_id);

CREATE TABLE workspace_identity_bindings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    connection_id UUID NOT NULL,
    user_id UUID NOT NULL,
    issuer TEXT COLLATE "C" NOT NULL CHECK (length(issuer) BETWEEN 1 AND 512),
    subject TEXT COLLATE "C" NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_authenticated_at TIMESTAMPTZ,
    FOREIGN KEY (workspace_id, connection_id)
        REFERENCES workspace_identity_connections(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, user_id)
        REFERENCES workspace_members(workspace_id, user_id) ON DELETE CASCADE,
    UNIQUE (connection_id, issuer, subject),
    UNIQUE (connection_id, user_id)
);
CREATE INDEX idx_workspace_identity_bindings_member
    ON workspace_identity_bindings (workspace_id, user_id, id);
CREATE INDEX idx_workspace_identity_bindings_user
    ON workspace_identity_bindings (user_id);

-- A session may prove more than one company's identity. Unlinking a binding must not erase the
-- fact that a still-existing global session was authenticated through that connection.
CREATE TABLE workspace_identity_sessions (
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL,
    connection_id UUID NOT NULL,
    binding_reference UUID NOT NULL,
    authentication_revision UUID NOT NULL,
    authenticated_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    PRIMARY KEY (session_id, connection_id),
    FOREIGN KEY (workspace_id, connection_id)
        REFERENCES workspace_identity_connections(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_workspace_identity_sessions_connection
    ON workspace_identity_sessions (workspace_id, connection_id, session_id);
CREATE INDEX idx_workspace_identity_sessions_binding
    ON workspace_identity_sessions (binding_reference, revoked_at, session_id);
