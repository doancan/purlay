-- An APNs registration belongs to one session (D-342, #1559).
CREATE TABLE IF NOT EXISTS apns_subscriptions (
    session_id UUID PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    device_token TEXT NOT NULL UNIQUE CHECK (
        length(device_token) BETWEEN 2 AND 512
        AND length(device_token) % 2 = 0
        AND device_token COLLATE "C" !~ '[^0-9a-f]'
    ),
    registered_at TIMESTAMPTZ NOT NULL,
    generation UUID NOT NULL DEFAULT gen_random_uuid()
);
