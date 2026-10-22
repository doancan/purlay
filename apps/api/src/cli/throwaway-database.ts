/**
 * A database of a command's own, for the scripts that start the API (`scripts/budget-api.ts`): a clone
 * of the test template made from the server `DATABASE_URL` names, and dropping it again. The API starts
 * with its migrations on and writes its settings where it is started, so it is never started on the
 * database `DATABASE_URL` names itself (D-179 §4.9) — the one a developer works in.
 *
 *   bun apps/api/src/cli/throwaway-database.ts clone        prints the clone's connection string
 *   bun apps/api/src/cli/throwaway-database.ts drop <name>  drops a clone, and nothing else
 *
 * The scripts live outside the workspaces and cannot import `@purlay/db`; `budget-latency.ts` beside
 * this file makes its clone in-process for the same reason.
 */
import { cloneIntegrationDatabase, dropDatabases } from '@purlay/db';

/** A clone's name: its source's and twelve hexadecimal digits (`cloneIntegrationDatabase`). */
const CLONE_NAME = /^[a-z0-9_]+_[0-9a-f]{12}$/;

const [command, name] = process.argv.slice(2);
if (command === 'clone') {
  const clone = await cloneIntegrationDatabase();
  // Its pool closed; the database stays until `drop`.
  await clone.db.destroy();
  console.log(clone.connectionString);
} else if (command === 'drop' && name !== undefined && CLONE_NAME.test(name)) {
  await dropDatabases([name]);
} else {
  console.error('usage: throwaway-database.ts clone | drop <name of a clone>');
  process.exit(2);
}
