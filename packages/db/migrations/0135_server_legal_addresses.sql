-- The server can publish its own optional privacy policy and terms addresses.
ALTER TABLE server_settings
    ADD COLUMN privacy_url text CHECK (char_length(privacy_url) BETWEEN 1 AND 2048),
    ADD COLUMN terms_url text CHECK (char_length(terms_url) BETWEEN 1 AND 2048);
