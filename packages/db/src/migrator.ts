import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql, type Kysely } from 'kysely';
// Kysely 0.29 moved migration support to its own subpath export.
import {
  Migrator,
  type Migration,
  type MigrationProvider,
  type MigrationResultSet,
} from 'kysely/migration';

export const MIGRATIONS_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '../migrations');

/**
 * Migrations are `.sql` files, numbered and applied in order.
 *
 * SQL rather than a query-builder script because the schema *is* SQL: partial
 * indexes, CHECK constraints and explicit collations are where half this
 * schema's correctness lives, and expressing them through a builder would put a
 * translation layer between the document and the database. (`SCHEMA.md`)
 *
 * **There are no down migrations, deliberately.** A rollback script runs once,
 * in an emergency, having never been executed successfully — which is the worst
 * possible moment to discover it is wrong. A bad migration is fixed by another
 * migration, and data loss is recovered from point-in-time recovery (D-44).
 * Append-only means the history is the truth. (`CONTRIBUTING.md` §1.6)
 */
class SqlFileMigrationProvider implements MigrationProvider {
  // A field rather than a parameter property: parameter properties are
  // TypeScript-only syntax that a type-stripping runtime cannot erase, which
  // `erasableSyntaxOnly` refuses. (D-47)
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async getMigrations(): Promise<Record<string, Migration>> {
    const files = (await readdir(this.#directory)).filter((f) => f.endsWith('.sql')).sort();
    const migrations: Record<string, Migration> = {};

    for (const file of files) {
      const statements = await readFile(join(this.#directory, file), 'utf8');
      migrations[file.replace(/\.sql$/, '')] = {
        up: async (db: Kysely<unknown>): Promise<void> => {
          await sql.raw(statements).execute(db);
        },
      };
    }
    return migrations;
  }
}

// The migrator does not know the schema — it is what produces it. Typing it
// against the generated shape would make the two circular. (D-45)
export const createMigrator = (db: Kysely<unknown>, directory = MIGRATIONS_DIRECTORY): Migrator =>
  new Migrator({ db, provider: new SqlFileMigrationProvider(directory) });

/** Idempotent: applying an already-applied migration is a no-op. */
export const migrateToLatest = async (
  db: Kysely<unknown>,
  directory = MIGRATIONS_DIRECTORY,
): Promise<MigrationResultSet> => await createMigrator(db, directory).migrateToLatest();
