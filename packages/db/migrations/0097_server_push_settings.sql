-- Web Push belongs to the server's settings (#1325). Existing VAPID environment values are seeded
-- once by the application, under this row's lock. Disabling keeps the pair for existing devices.
ALTER TABLE server_settings ADD COLUMN push_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE server_settings ADD COLUMN push_public_key text;
-- CredentialCipher seals this with this column's name as authenticated data; never returned.
ALTER TABLE server_settings ADD COLUMN push_private_key_encrypted text;
ALTER TABLE server_settings ADD COLUMN push_subject text;
ALTER TABLE server_settings ADD COLUMN push_imported_from_env_at timestamptz;
ALTER TABLE server_settings ADD CONSTRAINT server_settings_push_pair CHECK (
    (push_public_key IS NULL AND push_private_key_encrypted IS NULL AND push_subject IS NULL)
    OR (push_public_key <> '' AND push_private_key_encrypted <> '' AND push_subject <> ''
        AND push_public_key IS NOT NULL AND push_private_key_encrypted IS NOT NULL AND push_subject IS NOT NULL)
);
ALTER TABLE server_settings ADD CONSTRAINT server_settings_push_enabled CHECK (
    NOT push_enabled OR push_public_key IS NOT NULL
);
