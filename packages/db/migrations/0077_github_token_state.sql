-- purlay: no-transaction
-- 0077_github_token_state
--
-- What is known of the workspace's GitHub token beyond that it is set (D-23, amended; #884):
--
--   * `token_invalid_at`: when GitHub first answered the token `401`, so the admin is told it was
--     revoked or expired and no call is made with it until it is replaced. NULL is "not known to be
--     bad", as every row is. Replacing or removing the token clears it.
--   * `token_scopes`: the `X-OAuth-Scopes` header GitHub gave when the token was saved, verbatim. A
--     classic token carries it (empty when it has no scope); a fine-grained token has none, and NULL
--     is that, or a token saved before this column. It is read only to warn that a classic token with
--     `repo` is broader than the cards need.
--
-- Rollback: nothing else reads these. `ALTER TABLE github_integrations DROP COLUMN token_invalid_at,
-- DROP COLUMN token_scopes` in a new migration undoes it; every token is then taken as good again
-- until GitHub says otherwise.
--
-- On a table with a row per workspace, outside the migrator's transaction (D-86): nullable columns
-- without a default are catalogue changes. Each step can run again.

SET lock_timeout = '10s';

ALTER TABLE github_integrations ADD COLUMN IF NOT EXISTS token_invalid_at TIMESTAMPTZ;
ALTER TABLE github_integrations ADD COLUMN IF NOT EXISTS token_scopes TEXT;

RESET lock_timeout;
