/**
 * The tables chat names (D-271, `MODULES.md` §4, §5): its own, which `TABLE_OWNERS` says, and the core tables it reads, which
 * `module-tables.test.ts` also holds the text of chat's raw SQL to. A function of chat takes `ChatDb` or `ChatTx` where it
 * would have taken the whole database's executor, and a query over a table that is neither does not compile. Callers pass
 * what they always did: the type is the object's, not a wrapper. Adding a core table here is a line a reviewer reads, as an
 * import is.
 *
 * A message such as "not assignable to `TableExpressionOrList<ChatSchema, …>`" is this type refusing a table.
 */
import type { ModuleDb, ModuleSchema, ModuleTransaction } from '@purlay/db';

export const CORE_READS = ['users', 'workspaces', 'workspace_members', 'attachments'] as const;

export type ChatSchema = ModuleSchema<'chat', (typeof CORE_READS)[number]>;
export type ChatDb = ModuleDb<ChatSchema>;
export type ChatTx = ModuleTransaction<ChatSchema>;
