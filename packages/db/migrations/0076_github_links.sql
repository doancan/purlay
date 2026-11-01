-- 0076_github_links
--
-- A conversation's GitHub work, and the record that makes creating it recoverable (D-246 §2–4).
--
--   * `github_links`: a root message linked to an issue or a pull request — one this person made from the
--     thread (`created`) or one somebody pointed at (`linked`, with the next step). Its title and state are kept
--     as GitHub last said them, with the instant GitHub said it (`state_at`, GitHub's own `updated_at`), so a
--     delivery that arrives out of order cannot move it back. The repository is held by its number as well as
--     its name, since a name is renamed and a number is not. Linking never resolves the question, and a link
--     outlives the installation that found it: it is a record, not a permission.
--   * `github_operations`: the bounded record of one attempt to create an issue, keyed by workspace, actor and
--     the client's own request id, so a click twice, a retry and a lost answer are one operation and not two
--     issues. `content_digest` is the SHA-256 of what was asked (never the words): the same id with other
--     content is a conflict. `marker` is the line appended to the issue's body — `purlay:` and the request id
--     — by which an answer that never came back is found again through GitHub's reads, never by posting again.
--     `status` is `pending` (claimed, GitHub not yet heard), `created`, `unknown` (GitHub did not answer, so
--     whether it was made is not known) or `refused` with a closed reason. Swept after thirty days.
--
-- Rollback: nothing outside the GitHub issue module reads them. `DROP TABLE github_operations, github_links` in a
-- new migration undoes it; no question, message or channel is changed by either.
--
-- New tables with no rows: one transaction, as 0075.

CREATE TABLE github_links (
    id                   UUID PRIMARY KEY,
    workspace_id         UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    channel_id           UUID NOT NULL,
    root_id              UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    repository_id        BIGINT NOT NULL,
    repository_full_name VARCHAR(140) NOT NULL,
    kind                 VARCHAR(8) NOT NULL,
    number               INTEGER NOT NULL,
    title                VARCHAR(256) NOT NULL,
    state                VARCHAR(8) NOT NULL,
    state_at             TIMESTAMPTZ NOT NULL,
    origin               VARCHAR(8) NOT NULL,
    created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL,

    CONSTRAINT github_links_root_item_key UNIQUE (root_id, repository_id, kind, number),
    CONSTRAINT github_links_kind_known CHECK (kind IN ('issue', 'pull')),
    CONSTRAINT github_links_state_known CHECK (state IN ('open', 'closed', 'merged')),
    -- Only a pull request is merged.
    CONSTRAINT github_links_merged_is_a_pull CHECK (state <> 'merged' OR kind = 'pull'),
    CONSTRAINT github_links_origin_known CHECK (origin IN ('created', 'linked')),
    CONSTRAINT github_links_number_positive CHECK (number > 0),
    CONSTRAINT github_links_channel_workspace_fkey
        FOREIGN KEY (channel_id, workspace_id) REFERENCES channels (id, workspace_id) ON DELETE CASCADE
);

-- Every foreign key indexed (D-89): the root's leads the unique key above.
CREATE INDEX idx_github_links_workspace ON github_links (workspace_id);
CREATE INDEX idx_github_links_channel ON github_links (channel_id);
CREATE INDEX idx_github_links_created_by ON github_links (created_by) WHERE created_by IS NOT NULL;
-- A delivery names a repository's item, and finds every thread that follows it.
CREATE INDEX idx_github_links_item ON github_links (repository_id, kind, number);

CREATE TABLE github_operations (
    id                   UUID PRIMARY KEY,
    workspace_id         UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    actor_id             UUID REFERENCES users(id) ON DELETE CASCADE,
    client_request_id    UUID NOT NULL,
    content_digest       TEXT COLLATE "C" NOT NULL,
    root_id              UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    repository_id        BIGINT NOT NULL,
    repository_full_name VARCHAR(140) NOT NULL,
    marker               TEXT COLLATE "C" NOT NULL,
    status               VARCHAR(8) NOT NULL,
    reason               VARCHAR(32),
    issue_number         INTEGER,
    attempts             INTEGER NOT NULL DEFAULT 0,
    created_at           TIMESTAMPTZ NOT NULL,
    updated_at           TIMESTAMPTZ NOT NULL,

    CONSTRAINT github_operations_request_key UNIQUE (workspace_id, actor_id, client_request_id),
    CONSTRAINT github_operations_status_known
        CHECK (status IN ('pending', 'created', 'unknown', 'refused')),
    CONSTRAINT github_operations_digest_is_a_digest CHECK (content_digest ~ '^[0-9a-f]{64}$'),
    -- A created operation names its issue; a refused one says why; nothing else does either.
    CONSTRAINT github_operations_created_has_issue CHECK ((status = 'created') = (issue_number IS NOT NULL)),
    CONSTRAINT github_operations_refused_has_reason CHECK ((status = 'refused') = (reason IS NOT NULL)),
    CONSTRAINT github_operations_attempts_bounded CHECK (attempts BETWEEN 0 AND 20)
);

CREATE INDEX idx_github_operations_root ON github_operations (root_id);
CREATE INDEX idx_github_operations_actor ON github_operations (actor_id) WHERE actor_id IS NOT NULL;
-- What the sweep deletes by, and what a delivery's marker is looked up by.
CREATE INDEX idx_github_operations_updated ON github_operations (updated_at);
CREATE INDEX idx_github_operations_marker ON github_operations (marker);
