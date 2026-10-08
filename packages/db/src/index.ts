/**
 * `@purlay/db` — the Kysely client, the migrations, and the generated schema types.
 *
 * `src/schema.ts` is generated from a database with every migration applied and
 * committed; it is never edited by hand, and CI fails on any diff against a
 * fresh generation. The migrations are the single source. (D-45)
 */
export { createDatabase, type DatabaseOptions, type Executor } from './client';
/**
 * The raw-SQL tag, for what the builder cannot say — `unnest`, a lateral pair.
 * Re-exported so the query builder still has one home (`CONTRIBUTING.md` §1.5).
 */
export { sql } from 'kysely';
export {
  createMigrator,
  migrateToLatest,
  MIGRATIONS_DIRECTORY,
  pendingMigrations,
} from './migrator';
export {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  integrationDatabase,
  withRollback,
  type ClonedDatabase,
} from './testing';
export type * from './schema';

/**
 * The generator names the root interface `DB`; the documents call it `Database`
 * (`ARCHITECTURE.md` §10, D-46). This is an alias, not a second definition — the
 * generated file is never edited by hand (D-45).
 */
export type { DB as Database } from './schema';
