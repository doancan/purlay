/**
 * The two production paths into the database, run for real: the client the API
 * opens, and the migrations applied to an empty database from the first.
 *
 * Both used to run only in production or by accident — the migrator's `up` only
 * when a test template happened to be missing — so their coverage depended on the
 * machine (#202). Here they run every time.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { createDatabase } from './client';
import { migrateToLatest } from './migrator';
import { integrationDatabase, closeIntegrationDatabase } from './testing';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const url = (): string => process.env['DATABASE_URL'] ?? '';

const onDatabase = (name: string): string => {
  const target = new URL(url());
  target.pathname = `/${name}`;
  return target.toString();
};

describe('integration: the database client and the migrations', () => {
  test('the client the API opens connects, queries and closes', async () => {
    const database = createDatabase({ connectionString: url(), poolSize: 1, ssl: false });
    try {
      const { rows } = await sql<{ answer: number }>`select 1 as answer`.execute(database);
      expect(rows).toEqual([{ answer: 1 }]);
    } finally {
      await database.destroy();
    }
  });

  test('every migration applies to an empty database, in order, and once', async () => {
    const shared = integrationDatabase();
    const name = `purlay_fresh_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await sql`create database ${sql.id(name)}`.execute(shared);
    const fresh = new Kysely<unknown>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: onDatabase(name), max: 1 }),
      }),
    });
    try {
      const first = await migrateToLatest(fresh);
      expect(first.error).toBeUndefined();
      const applied = (first.results ?? []).map((result) => [result.migrationName, result.status]);
      expect(applied.length).toBeGreaterThan(0);
      expect(applied.every(([, status]) => status === 'Success')).toBe(true);

      const again = await migrateToLatest(fresh);
      expect(again.results).toEqual([]);
    } finally {
      await fresh.destroy();
      await sql`drop database ${sql.id(name)} with (force)`.execute(shared);
    }
  });
});
