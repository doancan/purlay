/**
 * Apply every migration that has not been applied yet.
 *
 *   bun run db:migrate
 *
 * Idempotent, and safe to run on every start (`ARCHITECTURE.md` §11). There is
 * no rollback: a bad migration is fixed by another migration, and data loss is
 * recovered from point-in-time recovery (D-44). See `migrator.ts`.
 */
import { createDatabase, tlsFromEnvironment } from '../client';
import { migrateToLatest } from '../migrator';

const connectionString = process.env['DATABASE_URL'];
if (connectionString === undefined || connectionString === '') {
  console.error('DATABASE_URL is not set. See docs/CONFIG.md.');
  process.exit(1);
}

// The same TLS settings as the application, so a managed database that refuses a
// clear connection is migrated by the command that starts it (D-86). No statement
// timeout: an index build is meant to take as long as it takes, and a migration
// cut off halfway is the worse outcome (D-87).
const db = createDatabase({
  connectionString,
  poolSize: 1,
  ...tlsFromEnvironment(process.env),
  statementTimeoutMs: 0,
  connectionTimeoutMs: 10_000,
  onPoolError: (error) => {
    console.error('database connection error:', error.message);
  },
});

const { error, results } = await migrateToLatest(db, undefined, {
  onRetry: (retry) => {
    console.warn(
      `  retrying ${retry.migration}: attempt ${String(retry.attempt)} was ended as a deadlock victim; ` +
        `waiting ${String(retry.pauseMilliseconds)} ms`,
    );
  },
});

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
