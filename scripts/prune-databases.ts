/**
 * `bun run db:prune`: lists the scratch databases a test run, the demo or the browser suite made and a
 * killed run never dropped — and, with `--drop`, drops them — on the server `.env.test` names (or the
 * `DATABASE_URL` in the environment): the one place those runs are allowed to make databases. What counts
 * as scratch, and why it is dry by default, is `database-pruning.ts`.
 */
import { SQL } from 'bun';
import { prune, type DatabaseServer } from './database-pruning';

const url = process.env['DATABASE_URL'];
if (url === undefined || url === '') {
  console.error(
    'DATABASE_URL is not set: name the test server in .env.test (see .env.test.example).',
  );
  process.exit(2);
}
const admin = new URL(url);
admin.pathname = '/postgres';
const connection = new SQL(admin.toString());
const server: DatabaseServer = {
  databases: async () =>
    (await connection.unsafe<{ datname: string }[]>('select datname from pg_database')).map(
      (row) => row.datname,
    ),
  inUse: async () =>
    (
      await connection.unsafe<{ datname: string }[]>(
        'select distinct datname from pg_stat_activity where datname is not null',
      )
    ).map((row) => row.datname),
  // All at once, as the harness does: a drop makes the server run a checkpoint, and a request that
  // arrives while one runs is served by it. Every name matched an allow-list shape: no quote in it.
  drop: async (names) => {
    await Promise.all(
      names.map(async (name) => {
        await connection.unsafe(`drop database if exists "${name}" with (force)`);
      }),
    );
  },
};
try {
  await prune(server, new URL(url).pathname.slice(1), process.argv.includes('--drop'), console.log);
} finally {
  await connection.close();
}
