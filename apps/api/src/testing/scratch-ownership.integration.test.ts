/** A failed allocation must not claim or drop a database that was already there (#1202). */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeIntegrationDatabase,
  createDatabase,
  databaseNameFromUrl,
  dropDatabases,
  integrationDatabase,
  onDatabase,
  scratchDatabaseName,
  sql,
  type DatabasePool,
} from '@purlay/db';

const source = process.env['DATABASE_URL'] ?? '';
const root = new URL('../../../..', import.meta.url).pathname;
const directories: string[] = [];

afterAll(async () => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  await closeIntegrationDatabase();
});

const existingDatabaseSurvives = async (name: string, probe: () => void): Promise<void> => {
  const control = integrationDatabase();
  let owned = false;
  let db: DatabasePool | undefined;
  try {
    await sql`create database ${sql.id(name)}`.execute(control);
    owned = true;
    db = createDatabase({ connectionString: onDatabase(source, name), poolSize: 1 });
    await sql`create table owner_marker (n int)`.execute(db);
    await sql`insert into owner_marker values (42)`.execute(db);
    await db.destroy();
    db = undefined;
    probe();
    expect(
      (await sql`select datname from pg_database where datname = ${name}`.execute(control)).rows,
    ).toHaveLength(1);
    db = createDatabase({ connectionString: onDatabase(source, name), poolSize: 1 });
    expect((await sql<{ n: number }>`select n from owner_marker`.execute(db)).rows).toEqual([
      { n: 42 },
    ]);
  } finally {
    await db?.destroy();
    if (owned) await dropDatabases([name]);
  }
};

describe('integration: scratch database ownership', () => {
  test('an upgrade allocation refused as already existing does not drop its previous owner’s data', async () => {
    const seed = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const name = scratchDatabaseName(`${databaseNameFromUrl(source)}_upg_${seed}_r0`);
    const tree = mkdtempSync(join(tmpdir(), 'purlay-upgrade-ownership-'));
    directories.push(tree);
    mkdirSync(join(tree, 'packages/db/migrations'), { recursive: true });
    await existingDatabaseSurvives(name, () => {
      const script = `
      import { mock } from 'bun:test';
      import * as crypto from 'node:crypto';
      const original = { ...crypto };
      mock.module('node:crypto', () => ({ ...original, randomBytes: () => Buffer.from(${JSON.stringify(seed)}, 'hex') }));
      const { upgradeFrom } = await import(${JSON.stringify(new URL('./module-upgrade.ts', import.meta.url).href)});
      const { moduleCells } = await import(${JSON.stringify(new URL('./module-cells.ts', import.meta.url).href)});
      const { bundledModules } = await import(${JSON.stringify(new URL('../composition.ts', import.meta.url).href)});
      try {
        await upgradeFrom(${JSON.stringify(tree)}, 'allocation probe', process.env.DATABASE_URL, moduleCells(bundledModules).slice(0, 1));
        throw new Error('the duplicate allocation was not refused');
      } catch (error) {
        if (error?.code !== '42P04') throw error;
        console.log('duplicate-refused');
      }
    `;
      const child = Bun.spawnSync([process.execPath, '--no-env-file', '--eval', script], {
        cwd: root,
        env: { ...process.env, DATABASE_URL: source },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 30_000,
      });
      expect(
        child.exitCode === 0
          ? child.stdout.toString().trim()
          : child.stderr.toString().slice(-2000),
      ).toBe('duplicate-refused');
    });
  }, 60_000);

  test('a module-set fixture refused at creation does not drop the existing database in teardown', async () => {
    const seed = crypto.randomUUID();
    const name = scratchDatabaseName(
      `${databaseNameFromUrl(source)}_mset_${seed.replaceAll('-', '').slice(0, 8)}`,
    );
    const directory = mkdtempSync(join(tmpdir(), 'purlay-module-set-ownership-'));
    directories.push(directory);
    const preload = join(directory, 'seed.ts');
    writeFileSync(
      preload,
      `
    import { mock } from 'bun:test';
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: () => ${JSON.stringify(seed)}, configurable: true });
    // Only the SQL ownership lifecycle is under test; no real Redis service is contacted.
    mock.module(${JSON.stringify(new URL('../platform/redis.ts', import.meta.url).href)}, () => ({
      connectRedis: () => ({ send: () => Promise.resolve(0), close: () => undefined }),
      bunRedisClient: () => undefined,
    }));
  `,
    );
    await existingDatabaseSurvives(name, () => {
      const child = Bun.spawnSync(
        [
          process.execPath,
          '--no-env-file',
          'test',
          '--isolate',
          '--preload',
          preload,
          new URL('../realtime/module-set.redis.integration.test.ts', import.meta.url).pathname,
        ],
        {
          cwd: root,
          env: { ...process.env, DATABASE_URL: source, REDIS_URL: 'redis://127.0.0.1:1' },
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 30_000,
        },
      );
      expect(child.exitCode).toBe(1);
      expect(child.stderr.toString()).toContain('already exists');
      expect(child.exitedDueToTimeout).toBe(false);
    });
  }, 60_000);
});
