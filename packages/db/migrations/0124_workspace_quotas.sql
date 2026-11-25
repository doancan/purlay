-- 0124_workspace_quotas
--
-- What the operator lets one workspace do beyond, or short of, what every workspace may (#1306): a limit's override, one row per
-- workspace and kind. A workspace with no row for a kind takes the build's default for it (`quotas.ts`: `limitFor`), and a kind with
-- no default and no row is not limited. `kind` is a key and not a list: a build may not carry the module a kind names (`issues:rows`
-- is issues'), and a core table never names a module's (D-250 rule 5). A limit of 0 refuses every new one and is allowed; rows
-- already over a lowered limit are kept, and only new ones are refused.
--
-- `reason` is the operator's sentence, kept with the row; it names nobody. Written by `bun run quota:set` only.
--
-- Rollback: `DROP TABLE workspace_quotas`. The gate then falls back to the defaults, which is what every workspace without a row
-- already gets.
CREATE TABLE workspace_quotas (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]*(:[a-z][a-z0-9_]*)?$' AND char_length(kind) <= 48),
  -- At most what a JSON number and the gate's arithmetic hold exactly.
  limit_value bigint NOT NULL CHECK (limit_value BETWEEN 0 AND 9007199254740991),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, kind)
);
