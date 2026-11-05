/**
 * The core tables chat reads (D-271, `MODULES.md` §4): the list `module-tables.test.ts` holds chat's source to, beside its
 * own tables, which `TABLE_OWNERS` says. Adding one is a line a reviewer reads, as an import is. Chat's functions take
 * this schema's handle in place of the whole database's executor as they are moved behind it.
 */
export const CORE_READS = ['users', 'workspaces', 'workspace_members', 'attachments'] as const;
