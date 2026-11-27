-- Validate separately so the column-add lock is released before the scan.
ALTER TABLE push_intents VALIDATE CONSTRAINT push_intents_repeat_source;
