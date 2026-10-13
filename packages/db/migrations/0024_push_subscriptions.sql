-- 0024_push_subscriptions
--
-- Where a person's devices are told of what needs them while Purlay is closed (#78, D-126;
-- `SCHEMA.md` §4), and the language they are told in (D-41).
--
--   * One row per browser subscription: the push service's endpoint and the two keys the browser
--     gave for encrypting to it (RFC 8291). Not the server's secrets — only the browser can read
--     what is sent — but a person's, so they are never logged.
--   * **Tied to the session it was made in.** Signing out deletes the session's rows, and a push
--     needs the session live: a shared computer stops showing the last person's notices.
--   * The endpoint is unique across people: a browser signed into another account moves its
--     subscription there rather than telling two.
--   * `server_key` is the application-server key it was made with: after the operator changes it,
--     the old rows are inert and go on their first attempt.
--   * `failures` counts deliveries in a row the push service did not take; past a bound the row goes.
--   * `users.locale` is the language a person's notifications are written in, set by their client.
--
-- Re-runnable: what it adds is dropped first.

DROP TABLE IF EXISTS push_subscriptions;
ALTER TABLE users DROP COLUMN IF EXISTS locale;

ALTER TABLE users ADD COLUMN locale TEXT NOT NULL DEFAULT 'en'
    CONSTRAINT users_locale_known CHECK (locale IN ('en', 'tr'));

CREATE TABLE push_subscriptions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id    UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    endpoint      TEXT NOT NULL UNIQUE,
    p256dh        TEXT NOT NULL,
    auth          TEXT NOT NULL,
    server_key    TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    failures      INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT push_subscriptions_endpoint_is_https CHECK (endpoint LIKE 'https://%'),
    CONSTRAINT push_subscriptions_endpoint_bounded CHECK (length(endpoint) <= 2048),
    CONSTRAINT push_subscriptions_failures_counted CHECK (failures >= 0)
);

-- A person's devices, oldest first: what a send reads, and what the bound drops from.
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions (user_id, created_at);
-- Signing out deletes by session (D-89: every foreign key indexed).
CREATE INDEX idx_push_subscriptions_session ON push_subscriptions (session_id);
