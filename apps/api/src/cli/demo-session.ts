/**
 * A new session for one person of the demo or the browser suite's world, printed as its token.
 *
 *   DATABASE_URL=postgres://…/purlay_e2e_4173 bun run apps/api/src/cli/demo-session.ts --as erin
 *
 * **Scratch databases only** (`assertDemoDatabase`): a session printed from a real database would
 * be a way in with no sign-in. Not imported by anything that ships, like `seed-demo.ts`.
 */
import { createDatabase } from '@purlay/db';
import { systemClock } from '../platform/clock';
import { freshSession } from './demo-seed';

const at = process.argv.indexOf('--as');
const username = at === -1 ? undefined : process.argv[at + 1];
const url = process.env['DATABASE_URL'];
if (username === undefined || url === undefined) {
  process.stderr.write(
    'usage: DATABASE_URL=… bun run apps/api/src/cli/demo-session.ts --as <name>\n',
  );
  process.exit(2);
}

const database = createDatabase({ connectionString: url, poolSize: 1 });
try {
  process.stdout.write(`${await freshSession(database, systemClock, url, username)}\n`);
} finally {
  await database.destroy();
}
