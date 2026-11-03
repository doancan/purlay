/**
 * The tables the migrator keeps. What a workspace's export and a person's hold is described by the contributions
 * of the core (`core-export.ts`, `core-personal-export.ts`) and of each module (D-250), assembled in
 * `export-catalogue.ts`.
 */

/** The migrator's own tables: not in the generated schema at all, and not anybody's record. */
export const MIGRATOR_TABLES: readonly string[] = ['kysely_migration', 'kysely_migration_lock'];
