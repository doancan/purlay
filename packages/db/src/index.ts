/**
 * `@purlay/db` — the Kysely client, the migrations, and the generated schema types.
 *
 * `src/schema.ts` is generated from a database with every migration applied and
 * committed; it is never edited by hand, and CI fails on any diff against a
 * fresh generation. The migrations are the single source. (D-45)
 */
export {
  createDatabase,
  createMigrationDatabase,
  type MigrationConnection,
  DatabaseUnavailableError,
  isTransaction,
  POOL_DEFAULTS,
  readCaFile,
  tlsFromEnvironment,
  type DatabaseOptions,
  type Executor,
  type Transaction,
} from './client';
export { purgeDeadSessions } from './sessions';
/**
 * The raw-SQL tag, for what the builder cannot say — `unnest`, a lateral pair.
 * Re-exported so the query builder still has one home (`CONTRIBUTING.md` §1.5).
 */
export { sql } from 'kysely';
export type { SelectQueryBuilder } from 'kysely';
export {
  migrateToLatest,
  type MigrateOptions,
  MIGRATIONS_DIRECTORY,
  migrationHistoryProblem,
  pendingMigrations,
  readMigrationFiles,
  type MigrationFile,
  type MigrationResult,
  type MigrationResultSet,
} from './migrator';
export {
  buildIntegrationTemplate,
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  dropDatabases,
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
