/**
 * The tables issues may name (D-271, `MODULES.md` §4, §5): its own, which `TABLE_OWNERS` says, and the core's it reads.
 * A function of the module takes `IssuesDb` or `IssuesTx` where it would have taken the whole database's executor, and a
 * query over any other table does not compile. Callers pass what they always did: the type is the object's, not a wrapper.
 *
 * Adding a core table here is a line a reviewer reads, as an import is; `module-tables.test.ts` reads the list too, to hold
 * the text of the module's raw SQL to it. A table issues owns joins by being added to `TABLE_OWNERS`, which it must be for
 * the schema to compile.
 */
import type { ModuleDb, ModuleSchema, ModuleTransaction } from '@purlay/db';

export const CORE_READS = ['users', 'workspaces', 'workspace_members'] as const;

type IssuesSchema = ModuleSchema<'issues', (typeof CORE_READS)[number]>;
export type IssuesDb = ModuleDb<IssuesSchema>;
export type IssuesTx = ModuleTransaction<IssuesSchema>;
