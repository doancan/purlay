-- Durable notification delivery, without storing message bodies or copying device credentials.
ALTER TABLE push_subscriptions
    ADD COLUMN generation UUID NOT NULL DEFAULT gen_random_uuid();

CREATE FUNCTION replace_push_subscription_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.user_id, NEW.session_id, NEW.endpoint, NEW.p256dh, NEW.auth, NEW.server_key)
       IS DISTINCT FROM
       ROW(OLD.user_id, OLD.session_id, OLD.endpoint, OLD.p256dh, OLD.auth, OLD.server_key) THEN
        NEW.generation := gen_random_uuid();
    ELSE
        NEW.generation := OLD.generation;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER push_subscription_generation
    BEFORE UPDATE ON push_subscriptions
    FOR EACH ROW EXECUTE FUNCTION replace_push_subscription_generation();

CREATE TABLE push_intents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('message', 'inbox')),
    source_id UUID NOT NULL,
    record_id UUID NOT NULL,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    module TEXT NOT NULL CHECK (length(module) BETWEEN 1 AND 64),
    kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    next_check_at TIMESTAMPTZ NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'admitted', 'completed', 'throttled', 'canceled', 'overflow')),
    reported_at TIMESTAMPTZ,
    UNIQUE (source_kind, source_id),
    CONSTRAINT push_intents_lifetime CHECK (
        isfinite(created_at) AND isfinite(expires_at)
        AND expires_at > created_at AND expires_at <= created_at + interval '1 day'
    )
);

CREATE INDEX idx_push_intents_due ON push_intents (next_check_at, id)
    WHERE state IN ('pending', 'admitted');
CREATE INDEX idx_push_intents_person ON push_intents (user_id, created_at DESC, id DESC);
CREATE INDEX idx_push_intents_workspace ON push_intents (workspace_id);
CREATE INDEX idx_push_intents_expiry ON push_intents (expires_at);
CREATE INDEX idx_push_intents_overflow ON push_intents (id)
    WHERE state = 'overflow' AND reported_at IS NULL;

CREATE TABLE push_deliveries (
    intent_id UUID NOT NULL REFERENCES push_intents(id) ON DELETE CASCADE,
    subscription_id UUID NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
    generation UUID NOT NULL,
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'delivered', 'canceled', 'exhausted', 'refused')),
    attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
    next_attempt_at TIMESTAMPTZ NOT NULL,
    lease_id UUID,
    last_status INTEGER CHECK (last_status BETWEEN 100 AND 599),
    last_failure TEXT CHECK (length(last_failure) <= 64),
    PRIMARY KEY (intent_id, subscription_id, generation)
);

CREATE INDEX idx_push_deliveries_due ON push_deliveries (next_attempt_at, intent_id)
    WHERE state = 'pending';
CREATE INDEX idx_push_deliveries_subscription ON push_deliveries (subscription_id);
CREATE INDEX idx_push_deliveries_session ON push_deliveries (session_id);

-- Admission is once per occurrence, not once per device or retry. One token a minute, burst three.
CREATE TABLE push_notice_budgets (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    module TEXT NOT NULL CHECK (length(module) BETWEEN 1 AND 64),
    kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
    next_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, module, kind),
    CONSTRAINT push_notice_budgets_window CHECK (
        isfinite(next_at) AND isfinite(updated_at)
        AND next_at <= updated_at + interval '3 minutes'
    )
);
CREATE INDEX idx_push_notice_budgets_retention ON push_notice_budgets (updated_at);
