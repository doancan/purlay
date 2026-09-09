/**
 * Apply every migration that has not been applied yet.
 *
 *   bun run db:migrate
 *
 * Idempotent, and safe to run on every start (`ARCHITECTURE.md` §11). There is
 * no rollback: a bad migration is fixed by another migration, and data loss is
 * recovered from point-in-time recovery (D-44). See `migrator.ts`.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { migrateToLatest } from '../migrator';

const connectionString = process.env['DATABASE_URL'];
if (connectionString === undefined || connectionString === '') {
  console.error('DATABASE_URL is not set. See docs/CONFIG.md.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString, max: 1 });
const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });

const { error, results } = await migrateToLatest(db);

for (const result of results ?? []) {
  const mark = result.status === 'Success' ? 'applied ' : 'FAILED  ';
  console.log(`  ${mark} ${result.migrationName}`);
}

await db.destroy();

if (error !== undefined) {
  console.error('\nmigration failed:', error);
  process.exit(1);
}
if ((results ?? []).length === 0) console.log('  nothing to apply — already up to date');
