-- 0057_session_device_name
--
-- What a device list names a session by (D-193): the name the native application gave the Mac it signs in on,
-- written when the one-time code is spent (D-191). Null for a browser's session, which is named by nothing the
-- person chose; `user_agent` stays the operator's label and is never read back to a client.
--
-- Bounded as the request is (`NATIVE_DEVICE_NAME_PATTERN`: one to sixty-four characters, no control, bidirectional
-- or zero-width ones), so a row cannot hold what the endpoint would have refused.
--
-- No data moves: every existing session is a browser's or predates the column, and is named by nothing.

ALTER TABLE sessions ADD COLUMN device_name TEXT;

ALTER TABLE sessions
    ADD CONSTRAINT sessions_device_name_bounded
    CHECK (device_name IS NULL OR char_length(device_name) BETWEEN 1 AND 64);
