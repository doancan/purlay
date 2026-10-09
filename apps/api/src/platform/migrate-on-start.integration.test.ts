import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, readMigrationFiles, sql } from '@purlay/db';
import type { Executor } from '@purlay/db';
import { migrateOnStart } from './migrate-on-start';

/**
 * Migrate on start (#248, D-93): against a database that has never been migrated,
 * which is the case the feature exists for, and with real processes, because two
 * nodes starting together is a property of processes and not of a function.
 */
const source = process.env['DATABASE_URL'];
if (source === undefined || source === '') {
  throw new Error('DATABASE_URL is not set, so these tests would silently prove nothing.');
}

const urlFor = (name: string): string => {
  const url = new URL(source);
  url.pathname = `/${name}`;
  return url.toString();
};

const BASE = `${new URL(source).pathname.slice(1)}_mos_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
const admin = createDatabase({ connectionString: urlFor('postgres'), poolSize: 1 });
const created: string[] = [];
const freshDatabase = async (suffix: string): Promise<{ name: string; db: Executor }> => {
  const name = `${BASE}_${suffix}`;
  await sql`create database ${sql.id(name)}`.execute(admin);
  created.push(name);
  return { name, db: createDatabase({ connectionString: urlFor(name), poolSize: 4 }) };
};

const recorded = async (db: Executor): Promise<string[]> => {
  const { rows } = await sql<{
    name: string;
  }>`select name from kysely_migration order by name`.execute(db);
  return rows.map((row) => row.name);
};

const failure = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('expected the promise to reject');
};

const freePort = (): number => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = probe.port ?? 0;
  void probe.stop(true);
  return port;
};

afterAll(async () => {
  for (const name of created) await sql`drop database ${sql.id(name)} with (force)`.execute(admin);
  await admin.destroy();
});

describe('integration: migrate on start', () => {
  test('an empty database is migrated to the latest, and starting again changes nothing', async () => {
    const { name, db } = await freshDatabase('one');
    try {
      const files = (await readMigrationFiles()).map((file) => file.name);
      expect(await migrateOnStart({ connectionString: urlFor(name) })).toEqual(files);
      expect(await recorded(db)).toEqual(files);
      expect(await migrateOnStart({ connectionString: urlFor(name) })).toEqual([]);
    } finally {
      await db.destroy();
    }
  });

  test('a migration that fails stops the start, naming it and keeping the cause', async () => {
    const { name, db } = await freshDatabase('bad');
    const directory = mkdtempSync(join(tmpdir(), 'migrations-'));
    writeFileSync(join(directory, '0001_broken.sql'), 'this is not sql;');
    try {
      const failed = await failure(migrateOnStart({ connectionString: urlFor(name) }, directory));
      expect(failed.message).toContain('0001_broken');
      expect(failed.cause).toBeDefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
      await db.destroy();
    }
  });

  /**
   * The application's pool cancels a statement after 30 s (D-87), and the migrator is not
   * the application: an index built on a table of millions of rows is meant to take as long
   * as it takes, and a node whose migration is cancelled exits, restarts, and is cancelled
   * at the same point again. Migrating on start uses a connection of its own, made as
   * `bun run db:migrate` makes it, so the timeout is off. A migration that records what
   * its own session was given shows it without needing one that runs for thirty seconds.
   */
  test('the migration runs on a session with no statement timeout, as the CLI gives it', async () => {
    const { name, db } = await freshDatabase('timeout');
    const directory = mkdtempSync(join(tmpdir(), 'migrations-'));
    writeFileSync(
      join(directory, '0001_seen.sql'),
      "CREATE TABLE seen AS SELECT current_setting('statement_timeout') AS timeout,\n" +
        "current_setting('application_name') AS application;",
    );
    try {
      expect(await migrateOnStart({ connectionString: urlFor(name) }, directory)).toEqual([
        '0001_seen',
      ]);
      const { rows } = await sql<{ timeout: string; application: string }>`
        select timeout, application from seen`.execute(db);
      expect(rows).toEqual([{ timeout: '0', application: 'purlay-api' }]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      await db.destroy();
    }
  });

  test('the connection it opens is closed when it is done, whether or not it succeeded', async () => {
    const { name, db } = await freshDatabase('closed');
    const directory = mkdtempSync(join(tmpdir(), 'migrations-'));
    writeFileSync(join(directory, '0001_broken.sql'), 'this is not sql;');
    const sessions = async (): Promise<number> =>
      Number(
        (
          await sql<{ n: string }>`
            select count(*) as n from pg_stat_activity
            where datname = ${name} and pid <> pg_backend_pid()`.execute(admin)
        ).rows[0]?.n,
      );
    try {
      await failure(migrateOnStart({ connectionString: urlFor(name) }, directory));
      expect(await sessions()).toBe(0);
      writeFileSync(join(directory, '0001_broken.sql'), 'CREATE TABLE fine (id int);');
      await migrateOnStart({ connectionString: urlFor(name) }, directory);
      expect(await sessions()).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      await db.destroy();
    }
  });

  test('two API processes started at the same instant migrate once, and both become ready', async () => {
    const { name, db } = await freshDatabase('race');
    const ports = [freePort(), freePort()];
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
    const entry = join(import.meta.dir, '../index.ts');

    const nodes = ports.map((port) =>
      Bun.spawn(['bun', entry], {
        stdout: 'ignore',
        stderr: 'ignore',
        env: {
          PATH: process.env['PATH'] ?? '',
          NODE_ENV: 'development',
          PORT: String(port),
          APP_URL: `http://localhost:${String(port)}`,
          DATABASE_URL: urlFor(name),
          GITHUB_CLIENT_ID: 'id',
          GITHUB_CLIENT_SECRET: 'secret',
          ENCRYPTION_KEY: key,
          MIGRATE_ON_START: 'true',
        },
      }),
    );

    try {
      const ready = async (port: number): Promise<number> => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const status = await fetch(`http://127.0.0.1:${String(port)}/health/ready`).then(
            (response) => response.status,
            () => 0,
          );
          if (status === 200) return 200;
          await Bun.sleep(150);
        }
        return 0;
      };
      const answers = await Promise.all(ports.map(ready));
      const files = (await readMigrationFiles()).map((file) => file.name);
      // Both answered, neither exited (a node that cannot migrate exits 1), and every
      // migration is recorded once: `name` is the primary key, so twice is an error.
      expect({
        answers,
        stillRunning: nodes.map((node) => node.exitCode === null),
        recorded: await recorded(db),
      }).toEqual({ answers: [200, 200], stillRunning: [true, true], recorded: files });
    } finally {
      for (const node of nodes) node.kill();
      await Promise.all(nodes.map((node) => node.exited));
      await db.destroy();
    }
  }, 90_000);
});
