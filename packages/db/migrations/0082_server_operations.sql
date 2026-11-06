-- D-277: bounded operational evidence, with no credentials, recipient or raw failure text.
CREATE TABLE server_operational_status (
    id boolean PRIMARY KEY DEFAULT true CHECK (id = true),
    smtp_tested_at timestamptz,
    smtp_accepted boolean,
    smtp_reason text,
    smtp_host text,
    CHECK ((smtp_tested_at IS NULL AND smtp_accepted IS NULL AND smtp_reason IS NULL AND smtp_host IS NULL)
        OR (smtp_tested_at IS NOT NULL AND smtp_accepted IS NOT NULL AND smtp_host IS NOT NULL))
);
INSERT INTO server_operational_status (id) VALUES (true);
