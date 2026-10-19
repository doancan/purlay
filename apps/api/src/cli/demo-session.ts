/**
 * A new session for one person of the demo or the browser suite's world, printed as its token — or,
 * with `--new`, a new person with one session, printed as their id and token.
 *
 *   DATABASE_URL=postgres://…/purlay_e2e_4173 bun run apps/api/src/cli/demo-session.ts --as erin
 *   DATABASE_URL=postgres://…/purlay_e2e_4173 bun run apps/api/src/cli/demo-session.ts --new hana-1a2b
 *
 * **Scratch databases only** (`assertDemoDatabase`): a session printed from a real database would
 * be a way in with no sign-in. Not imported by anything that ships, like `seed-demo.ts`.
 */
import { createDatabase } from '@purlay/db';
import { systemClock } from '../platform/clock';
import { freshPerson, freshSession } from './demo-seed';

const valueOf = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
};
const existing = valueOf('--as');
const made = valueOf('--new');
const url = process.env['DATABASE_URL'];
if ((existing === undefined) === (made === undefined) || url === undefined) {
  process.stderr.write(
    'usage: DATABASE_URL=… bun run apps/api/src/cli/demo-session.ts --as <name> | --new <name>\n',
  );
  process.exit(2);
}

const database = createDatabase({ connectionString: url, poolSize: 1 });
try {
  if (made !== undefined) {
    const person = await freshPerson(database, systemClock, url, made);
    process.stdout.write(`${person.userId} ${person.token}\n`);
  } else if (existing !== undefined) {
    process.stdout.write(`${await freshSession(database, systemClock, url, existing)}\n`);
  }
} finally {
  await database.destroy();
}
