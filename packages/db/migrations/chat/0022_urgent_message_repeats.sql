-- One bounded repeat cursor for the original notification and its account-wide read receipt.
CREATE TABLE urgent_message_repeats (
    notification_id UUID PRIMARY KEY REFERENCES notifications(id) ON DELETE CASCADE,
    next_at TIMESTAMPTZ NOT NULL CHECK (isfinite(next_at))
);

CREATE INDEX idx_urgent_message_repeats_due ON urgent_message_repeats (next_at, notification_id);
