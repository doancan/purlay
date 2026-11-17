-- Channel webhooks in both directions (D-312). Additive; old incoming clients keep working.
CREATE TABLE outgoing_webhooks (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    channel_id UUID NOT NULL,
    name VARCHAR(80) NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    url TEXT NOT NULL CHECK (char_length(url) <= 2048),
    secret_encrypted TEXT NOT NULL,
    events TEXT[] NOT NULL CHECK (cardinality(events) BETWEEN 1 AND 3 AND events <@ ARRAY['message.created', 'thread.resolved', 'thread.reopened']::text[]),
    paused BOOLEAN NOT NULL DEFAULT FALSE,
    revoked_at TIMESTAMPTZ,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT outgoing_webhooks_channel_workspace_fkey FOREIGN KEY (channel_id, workspace_id) REFERENCES channels(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX idx_outgoing_webhooks_channel ON outgoing_webhooks(channel_id, created_at);
CREATE INDEX idx_outgoing_webhooks_workspace ON outgoing_webhooks(workspace_id);
CREATE INDEX idx_outgoing_webhooks_creator ON outgoing_webhooks(created_by);

CREATE TABLE webhook_deliveries (
    id UUID PRIMARY KEY,
    webhook_id UUID NOT NULL REFERENCES outgoing_webhooks(id) ON DELETE CASCADE,
    message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    event_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','succeeded','failed','cancelled')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    lease_token UUID,
    lease_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    last_status INTEGER,
    last_error TEXT,
    UNIQUE (webhook_id, event_id)
);
CREATE INDEX idx_webhook_deliveries_due ON webhook_deliveries(state, next_attempt_at);
CREATE INDEX idx_webhook_deliveries_hook ON webhook_deliveries(webhook_id, created_at, id);
CREATE INDEX idx_webhook_deliveries_message ON webhook_deliveries(message_id);
CREATE INDEX idx_webhook_deliveries_actor ON webhook_deliveries(actor_id);
CREATE INDEX idx_webhook_deliveries_expiry ON webhook_deliveries(expires_at);

CREATE TABLE webhook_delivery_attempts (
    id UUID PRIMARY KEY,
    delivery_id UUID NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
    attempted_at TIMESTAMPTZ NOT NULL,
    duration_ms INTEGER NOT NULL,
    status INTEGER,
    error TEXT,
    UNIQUE (delivery_id, id)
);
CREATE INDEX idx_webhook_delivery_attempts_delivery ON webhook_delivery_attempts(delivery_id, attempted_at);
