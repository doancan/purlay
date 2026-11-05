/**
 * The preload brings the database the rollback harness uses up to date: a real `bun test`, started the way
 * the project starts it, against a database that has never been migrated, ends green. Without the preload's
 * migration it ends with "relation does not exist" — what a machine whose database was last migrated before
 * a migration was added used to meet, as a failure in tests that were about something else.
 */
import { describe, expect, test } from 'bun:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { dropDatabases } from './testing';

/**
 * A `bun test` started the way the project starts it, against a database that has never been migrated, with the
 * environment given: the probe reads what the preload left there.
 */
const probedRun = async (modules: string | undefined): Promise<{ code: number; said: string }> => {
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
    const environment = { ...process.env };
    delete environment['MODULES'];
    const run = Bun.spawnSync(
      ['bun', '--no-env-file', 'test', 'packages/db/src/preload-probe.test.ts'],
      {
        cwd: new URL('../../..', import.meta.url).pathname,
        env: {
          ...environment,
          DATABASE_URL: stale.toString(),
          PURLAY_PRELOAD_PROBE: '1',
          ...(modules === undefined ? {} : { MODULES: modules }),
        },
      },
    );
    return {
      code: run.exitCode,
      said: run.exitCode === 0 ? '' : run.stdout.toString() + run.stderr.toString(),
    };
  } finally {
    // The probe's own run made `${name}_template` and clones of it; both are ours to drop.
    await dropDatabases([`${name}_template`, name]);
    await control.destroy();
  }
};

describe('integration: the preload', () => {
  test.each([['none'], ['chat'], ['issues'], [undefined]])(
    'with MODULES %p it migrates the core and the sets that setting names, and no others',
    async (modules) => {
      expect(await probedRun(modules)).toEqual({ code: 0, said: '' });
    },
    120_000,
  );

  test('a run pointed at a database that was never migrated finds it migrated', async () => {
    expect(await probedRun(undefined)).toEqual({ code: 0, said: '' });
  }, 120_000);
});
