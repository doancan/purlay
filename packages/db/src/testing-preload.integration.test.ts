/**
 * The preload brings the database the rollback harness uses up to date: a real `bun test`, started the way
 * the project starts it, against a database that has never been migrated, ends green. Without the preload's
 * migration it ends with "relation does not exist" — what a machine whose database was last migrated before
 * a migration was added used to meet, as a failure in tests that were about something else.
 */
import { describe, expect, test } from 'bun:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

describe('integration: the preload', () => {
  test('a run pointed at a database that was never migrated finds it migrated', async () => {
    const source = new URL(process.env['DATABASE_URL'] ?? '');
    const name = `purlay_preload_probe_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const admin = new URL(source);
    admin.pathname = '/postgres';
    const stale = new URL(source);
    stale.pathname = `/${name}`;
    const control = new Kysely<unknown>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: admin.toString(), max: 1 }),
      }),
    });
    try {
      await sql`create database ${sql.id(name)}`.execute(control);
      const run = Bun.spawnSync(
        ['bun', '--no-env-file', 'test', 'packages/db/src/preload-probe.test.ts'],
        {
          cwd: new URL('../../..', import.meta.url).pathname,
          env: { ...process.env, DATABASE_URL: stale.toString(), PURLAY_PRELOAD_PROBE: '1' },
        },
      );
      const said = run.stdout.toString() + run.stderr.toString();
      expect({ code: run.exitCode, said: run.exitCode === 0 ? '' : said }).toEqual({
        code: 0,
        said: '',
      });
    } finally {
      // The probe's own run made `${name}_template` and clones of it; the template is ours to drop.
      await sql`drop database if exists ${sql.id(`${name}_template`)} with (force)`.execute(
        control,
      );
      await sql`drop database if exists ${sql.id(name)} with (force)`.execute(control);
      await control.destroy();
    }
  }, 120_000);
});
