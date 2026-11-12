-- Company authentication cannot inherit a canonical user's unrelated authority (D-309).
-- Deliberately no FK: deleting a company or its provenance must never turn this into a global session.
ALTER TABLE sessions ADD COLUMN company_workspace_id UUID;
