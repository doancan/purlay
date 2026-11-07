/**
 * The tables __ID__ may name (D-271, `MODULES.md` §4, §5): its own, which `TABLE_OWNERS` says, and the core's it reads.
 * Adding a core table here is a line a reviewer reads.
 */
import type { ModuleDb, ModuleSchema, ModuleTransaction } from '@purlay/db';

export const CORE_READS = ['workspaces'] as const;

type __PASCAL__Schema = ModuleSchema<'__ID__', (typeof CORE_READS)[number]>;
export type __PASCAL__Db = ModuleDb<__PASCAL__Schema>;
export type __PASCAL__Tx = ModuleTransaction<__PASCAL__Schema>;
