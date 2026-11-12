-- Keep native grants tied to their issuing company even if the browser session or workspace is purged.
-- Neither field may be cleared by a cascading foreign key and restore independent authority.
ALTER TABLE native_authorizations
    ADD COLUMN company_workspace_id UUID,
    ADD COLUMN company_source_session_id UUID,
    ADD CONSTRAINT native_authorizations_company_origin_pair
        CHECK ((company_workspace_id IS NULL) = (company_source_session_id IS NULL));
