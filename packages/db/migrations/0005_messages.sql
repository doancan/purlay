-- 0005_messages
--
-- The hot table. `id` has no default: the application supplies a UUIDv7 (D-8).
--
-- Append-only: never edited after it has been applied. The migrations are the
-- single source for the data model; packages/db/src/schema.ts is generated from
-- them and never written by hand. (D-45, CONTRIBUTING.md §1.6)

CREATE TABLE messages (
    -- No DEFAULT: the application supplies a UUIDv7. An insert that forgets one
    -- fails loudly instead of silently creating an unorderable row. (D-8)
    id           UUID PRIMARY KEY,

    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    channel_id   UUID NOT NULL REFERENCES channels(id)   ON DELETE CASCADE,

    -- RESTRICT, because users are soft-deleted and authorship must survive. (D-22)
    sender_id    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

    -- Threads are exactly two levels deep: a root message and its replies.
    -- A reply may not itself be a parent. Enforced in the message service.
    parent_id    UUID REFERENCES messages(id) ON DELETE RESTRICT,

    -- Denormalized thread summary, so rendering a feed of 50 root messages
    -- does not become 50 extra queries.
    thread_reply_count   INTEGER NOT NULL DEFAULT 0,
    thread_last_reply_at TIMESTAMPTZ,

    -- The wedge: a thread can be closed, and stays searchable. (D-2)
    resolved_at  TIMESTAMPTZ,
    resolved_by  UUID REFERENCES users(id) ON DELETE SET NULL,

    content      TEXT NOT NULL,
    message_type message_type NOT NULL DEFAULT 'text',

    -- Renderer hints and system-event payloads. Never used for tenant filtering.
    metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,

    edited_at    TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at   TIMESTAMPTZ,

    -- Only root messages are resolvable; resolving a reply is meaningless.
    CONSTRAINT only_roots_resolve CHECK (parent_id IS NULL OR resolved_at IS NULL),

    -- Resolution is all-or-nothing: never a timestamp without an actor.
    CONSTRAINT resolution_is_complete
        CHECK ((resolved_at IS NULL) = (resolved_by IS NULL)),

    -- Replies have no thread summary of their own.
    CONSTRAINT replies_have_no_thread_summary
        CHECK (parent_id IS NULL OR thread_reply_count = 0),

    CONSTRAINT thread_reply_count_non_negative CHECK (thread_reply_count >= 0)
);

-- Primary feed. Keyset pagination on `id` alone: UUIDv7 is byte-wise time-ordered,
-- and PostgreSQL compares the uuid type byte-wise, so this index IS chronological.
-- Root messages only, because thread replies render inline under their parent. (D-8)
CREATE INDEX idx_messages_channel_feed
    ON messages (channel_id, id DESC)
    WHERE parent_id IS NULL AND deleted_at IS NULL;

-- Expanding one thread.
CREATE INDEX idx_messages_thread
    ON messages (parent_id, id)
    WHERE parent_id IS NOT NULL AND deleted_at IS NULL;

-- Scoped substring / identifier search. btree_gin lets workspace_id sit inside the
-- GIN index, so the trigram scan is confined to one tenant instead of the whole table. (D-10)
CREATE INDEX idx_messages_search
    ON messages USING gin (workspace_id, content gin_trgm_ops)
    WHERE deleted_at IS NULL;

-- "Messages by this user", and the guard against orphaned RESTRICT references.
CREATE INDEX idx_messages_sender ON messages (sender_id);

-- Open questions across a workspace: the resolvable-thread feature's own view.
CREATE INDEX idx_messages_unresolved
    ON messages (workspace_id, id DESC)
    WHERE parent_id IS NULL AND resolved_at IS NULL AND deleted_at IS NULL;
