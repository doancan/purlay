-- 0037_incident_writeup
--
-- What is written down for an incident (#487, D-137 §3): the runbook it follows, and its postmortem.
--
--   * The runbook is a link, `https:` only, at most 2048 characters, or nothing.
--   * The postmortem is markdown, held to a message's own bound (0011's units), empty until written.
--     It is saved against the version it was edited from: `postmortem_version` counts its saves, and
--     a save from an older version is refused rather than written over somebody else's.
--   * The timeline gains the two kinds: the runbook's link in `to_value` (empty when cleared), and the
--     postmortem's version — never its words, which are the incident's, not the timeline's.
--
-- Columns with defaults on a small table and two CHECKs replaced: one transaction. Every row today
-- takes the defaults, which pass the new rules.

ALTER TABLE incidents ADD COLUMN runbook_url TEXT;
ALTER TABLE incidents ADD COLUMN postmortem TEXT NOT NULL DEFAULT '';
ALTER TABLE incidents ADD COLUMN postmortem_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE incidents ADD CONSTRAINT incidents_runbook_url CHECK (
    runbook_url IS NULL OR (runbook_url LIKE 'https://%' AND char_length(runbook_url) <= 2048)
);
ALTER TABLE incidents ADD CONSTRAINT incidents_postmortem_length CHECK (
    char_length(postmortem)
    + char_length(regexp_replace(postmortem, '[^\U00010000-\U0010FFFF]', '', 'g'))
    <= 16000
);
ALTER TABLE incidents ADD CONSTRAINT incidents_postmortem_version CHECK (postmortem_version >= 0);

ALTER TABLE incident_updates DROP CONSTRAINT incident_updates_kind_known;
ALTER TABLE incident_updates ADD CONSTRAINT incident_updates_kind_known CHECK (
    kind IN (
        'declared', 'status', 'severity', 'responder_added', 'responder_removed',
        'runbook', 'postmortem'
    )
);
