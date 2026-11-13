-- SQL CHECK treats NULL as accepted. Unknown primary evidence must have no company tuple (D-310).
-- Reject inconsistent rows rather than guessing the authority of already-recorded evidence.
SET lock_timeout = '10s';
ALTER TABLE session_authentication_evidence
    ADD CONSTRAINT session_authentication_company_tuple
    CHECK ((method IS NOT NULL AND method = 'company_oidc'
            AND company_workspace_id IS NOT NULL AND company_connection_id IS NOT NULL AND company_authentication_revision IS NOT NULL)
        OR (method IS DISTINCT FROM 'company_oidc'
            AND company_workspace_id IS NULL AND company_connection_id IS NULL AND company_authentication_revision IS NULL)) NOT VALID;
ALTER TABLE session_authentication_evidence VALIDATE CONSTRAINT session_authentication_company_tuple;
RESET lock_timeout;
