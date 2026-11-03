import { sql } from 'kysely';
import type { Executor } from './client';
import type { DB } from './schema';

/**
 * Whether the database has this table. A module's own migration set creates tables the core's migrations do
 * not, and a database migrated without that set has none of them (D-250, `MODULES.md` §5): what the module
 * keeps of a person or a workspace is erased, purged and exported where its tables are, and there is nothing
 * to do where they are not. Asked each time rather than remembered, because another node may apply the set
 * while this one runs, and a person's right to be erased does not wait for a restart.
 */
export const tableExists = async (executor: Executor, table: keyof DB): Promise<boolean> => {
  const { rows } = await sql<{ present: boolean }>`
    select to_regclass(${table}) is not null as present`.execute(executor);
  return rows[0]?.present === true;
};
