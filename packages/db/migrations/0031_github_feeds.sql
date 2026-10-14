-- 0031_github_feeds
--
-- A repository's feed into a channel (#79, D-134), and the deliveries it has posted.
--
--   * A feed is a channel's, in that channel's workspace (I-4): the composite key every channel row
--     has, so a feed cannot point across a tenant. It goes with its channel and its workspace.
--   * The repository is kept in lower case, as GitHub compares it, so `Org/Repo` and `org/repo` are
--     one feed; a channel has each repository once. Its numeric id is learnt from the first delivery
--     and is what later ones must match: a name can be renamed, an id cannot.
--   * The secret is sealed by the one cipher with the feed's id bound in (D-39 §6): base64 of
--     version, nonce, ciphertext and tag. Never logged, never returned after the first answer.
--   * `created_by` outlives its person as NULL: the feed is the channel's, and posts as nobody.
--   * The last failure is a code and its time, both or neither.
--   * A delivery is recorded in the transaction that posts it, once per feed (D-134 §5); a daily
--     sweep keeps 30 days of them, by `received_at`.
--
-- New tables with no rows: one transaction, as 0026.

CREATE TABLE github_repo_feeds (
    id                   UUID PRIMARY KEY,
    workspace_id         UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    channel_id           UUID NOT NULL,
    repository_full_name VARCHAR(140) COLLATE "C" NOT NULL,
    repository_id        BIGINT,
    events               TEXT[] NOT NULL,
    secret_encrypted     TEXT NOT NULL,
    created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_delivery_at     TIMESTAMPTZ,
    last_failure         VARCHAR(64),
    last_failure_at      TIMESTAMPTZ,

    CONSTRAINT github_repo_feeds_repository_shape CHECK (
        repository_full_name ~ '^[a-z0-9-]{1,39}/[a-z0-9._-]{1,100}$'
    ),
    CONSTRAINT github_repo_feeds_events_known CHECK (
        cardinality(events) >= 1
        AND events <@ ARRAY['push', 'pull_request', 'issues', 'release']::TEXT[]
    ),
    CONSTRAINT github_repo_feeds_failure_is_complete CHECK (
        (last_failure IS NULL) = (last_failure_at IS NULL)
    ),
    CONSTRAINT github_repo_feeds_channel_repository_key UNIQUE (channel_id, repository_full_name),
    CONSTRAINT github_repo_feeds_channel_workspace_fkey
        FOREIGN KEY (channel_id, workspace_id) REFERENCES channels (id, workspace_id)
        ON DELETE CASCADE
);

-- Every foreign key indexed (D-89); the channel's leads the unique key above.
CREATE INDEX idx_github_repo_feeds_workspace ON github_repo_feeds (workspace_id);
CREATE INDEX idx_github_repo_feeds_created_by ON github_repo_feeds (created_by)
    WHERE created_by IS NOT NULL;

CREATE TABLE github_deliveries (
    feed_id      UUID NOT NULL REFERENCES github_repo_feeds(id) ON DELETE CASCADE,
    -- GitHub's `X-GitHub-Delivery`, a GUID; bounded, since it is a header anybody may send.
    delivery_id  VARCHAR(64) COLLATE "C" NOT NULL,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (feed_id, delivery_id)
);

-- What the sweep deletes by.
CREATE INDEX idx_github_deliveries_received ON github_deliveries (received_at);
