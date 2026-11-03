import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDatabase,
  createMigrationDatabase,
  dropDatabases,
  migrateToLatest,
  migrationHistoryProblem,
  pendingMigrations,
  PRODUCT_MIGRATION_SETS,
  readMigrationFiles,
  sql,
} from '@purlay/db';
import type { Executor, MigrationSet } from '@purlay/db';
import { migrateOnStart, untilMigrated } from './migrate-on-start';
import { credentialCipher } from './crypto';
import { aRecordingLogger } from '../testing/doubles';
import { aGitHubPerson } from '../testing/github-sign-in';
import { aGitHubStub, GITHUB_STUB_CREDENTIALS } from '../testing/github-stub';

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

/** Every migration a process applies, in the order it applies them: the core's, then each module's set. */
const everyMigration = async (): Promise<string[]> => [
  ...(await readMigrationFiles()).map((file) => file.name),
  ...(
    await Promise.all(
      PRODUCT_MIGRATION_SETS.map(
        async (set) => await readMigrationFiles(set.directory, `${set.id}/`),
      ),
    )
  )
    .flat()
    .map((file) => file.name),
];

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

/** Spawns the API as a deployment runs it, against this database, with this much more environment. */
const aNode = (
  name: string,
  port: number,
  key: string,
  more: Record<string, string> = {},
  /** Variables the node is given no mention of at all, rather than an empty one. */
  without: readonly string[] = [],
): Bun.Subprocess<'ignore', 'pipe', 'pipe'> => {
  const environment: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    NODE_ENV: 'development',
    PORT: String(port),
    APP_URL: `http://localhost:${String(port)}`,
    DATABASE_URL: urlFor(name),
    GITHUB_CLIENT_ID: 'id',
    GITHUB_CLIENT_SECRET: 'secret',
    ENCRYPTION_KEY: key,
    ...more,
  };
  return Bun.spawn(['bun', '--no-env-file', join(import.meta.dir, '../index.ts')], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: Object.fromEntries(
      Object.entries(environment).filter(([name]) => !without.includes(name)),
    ),
  });
};

/** A path's status and its whole JSON body, `0` while nothing listens. */
const bodyOf = async (port: number, path: string): Promise<[number, unknown]> => {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, { redirect: 'manual' });
    return [response.status, await response.json().catch(() => undefined)];
  } catch {
    return [0, undefined];
  }
};

/** What a path answers, as a status and the error's code; `0` while nothing listens. */
const answer = async (port: number, path: string): Promise<[number, string | undefined]> => {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}${path}`);
    const body = (await response.json().catch(() => ({}))) as { error?: { code?: string } };
    return [response.status, body.error?.code];
  } catch {
    return [0, undefined];
  }
};

/** Waits until `condition` holds, for as long as a slow runner may take; says so when it never does. */
const waitUntil = async (condition: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 20_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(10);
  }
};

/** A module set of its own, one table, for a test that needs a set that is not every product set. */
const aSetOf = (id: string, table: string): { set: MigrationSet; remove: () => void } => {
  const directory = mkdtempSync(join(tmpdir(), 'migration-set-'));
  writeFileSync(join(directory, '0001_table.sql'), `CREATE TABLE ${table} (id int);`);
  return {
    set: { id, directory },
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
};

/** Applies the core and these sets to a database, as a process that runs those modules does. */
const migrateWith = async (name: string, sets: readonly MigrationSet[]): Promise<void> => {
  const database = createMigrationDatabase({ connectionString: urlFor(name) });
  try {
    const { error } = await migrateToLatest(database, undefined, { modules: sets });
    if (error !== undefined)
      throw new Error('migrating the test database failed', { cause: error });
  } finally {
    await database.destroy();
  }
};

const WAITING = 'waiting for the migrations before reading the settings';

/** Waits for a path to answer this status; answers what it last saw. */
const until = async (port: number, path: string, status: number): Promise<number> => {
  let last = 0;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    [last] = await answer(port, path);
    if (last === status) return last;
    await Bun.sleep(100);
  }
  return last;
};

/** The settings row as stored, the GitHub secret opened with the key the nodes were given. */
const storedSettings = async (
  db: Executor,
  key: string,
): Promise<{ rows: number; clientId: string | null; secret: string | null; imported: boolean }> => {
  const rows = await db
    .selectFrom('server_settings')
    .select(['github_client_id', 'github_client_secret_encrypted', 'imported_from_env_at'])
    .where('id', '=', true)
    .execute();
  const [row] = rows;
  const sealed = row?.github_client_secret_encrypted ?? null;
  return {
    rows: rows.length,
    clientId: row?.github_client_id ?? null,
    secret:
      sealed === null
        ? null
        : await credentialCipher(key).open(
            Buffer.from(sealed, 'base64'),
            'server_settings.github_client_secret_encrypted',
          ),
    imported: (row?.imported_from_env_at ?? null) !== null,
  };
};

/** A node's whole output once it has exited, or `still running` after the wait. */
const exitOf = async (
  node: Bun.Subprocess<'ignore', 'pipe', 'pipe'>,
): Promise<{ code: number | 'still running'; said: string }> => {
  const code = await Promise.race([
    node.exited,
    Bun.sleep(30_000).then(() => 'still running' as const),
  ]);
  node.kill();
  await node.exited;
  const said = `${await new Response(node.stdout).text()}${await new Response(node.stderr).text()}`;
  return { code, said };
};

/** The recovery after a rotated `ENCRYPTION_KEY`, exactly as `CONFIG.md` gives it to an operator. */
const recoveryInConfigDocument = (): string => {
  const document = readFileSync(join(import.meta.dir, '../../../../docs/CONFIG.md'), 'utf8');
  const statement = /`(UPDATE server_settings SET [^`]+;)`/.exec(document)?.[1];
  if (statement === undefined) throw new Error('CONFIG.md no longer gives the recovery statement');
  return statement;
};

// Every database the tests made, dropped together and after their connections have closed
// (`dropDatabases`); one at a time and forced, they outlived the five seconds a hook is given.
afterAll(async () => {
  await dropDatabases(created);
  await admin.destroy();
}, 120_000);

describe('integration: migrate on start', () => {
  test('an empty database is migrated to the latest, and starting again changes nothing', async () => {
    const { name, db } = await freshDatabase('one');
    try {
      const files = await everyMigration();
      expect(await migrateOnStart({ connectionString: urlFor(name) })).toEqual(files);
      expect(await recorded(db)).toEqual(files);
      expect(await migrateOnStart({ connectionString: urlFor(name) })).toEqual([]);
    } finally {
      await db.destroy();
    }
  });

  test('with no module set the core alone is applied, and a module opened later brings its own', async () => {
    const { name, db } = await freshDatabase('core-alone');
    try {
      const files = await everyMigration();
      const core = files.filter((file) => !file.includes('/'));
      expect(
        await migrateOnStart({ connectionString: urlFor(name) }, undefined, { sets: [] }),
      ).toEqual(core);
      const tables = async (): Promise<string[]> =>
        (
          await sql<{ table_name: string }>`
            select table_name from information_schema.tables where table_schema = current_schema()`.execute(
            db,
          )
        ).rows.map((row) => row.table_name);
      expect(await tables()).not.toContain('message_attachments');
      // Nothing is pending for a process that runs no module, and one that runs chat sees chat's set waiting.
      await untilMigrated(db, aRecordingLogger().log, 20, []);
      expect(await pendingMigrations(db, undefined, PRODUCT_MIGRATION_SETS)).toEqual(
        files.filter((file) => file.includes('/')),
      );
      // Opened later, chat's set is applied on top, and starting with it off again tolerates its rows.
      expect(await migrateOnStart({ connectionString: urlFor(name) })).toEqual(
        files.filter((file) => file.includes('/')),
      );
      expect(await tables()).toContain('message_attachments');
      expect(
        await migrateOnStart({ connectionString: urlFor(name) }, undefined, { sets: [] }),
      ).toEqual([]);
      expect(await migrationHistoryProblem(db, undefined, undefined, [])).toBeUndefined();
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
    // A closed connection's server process leaves `pg_stat_activity` a moment after the client
    // hangs up, so the count is waited on to reach zero; a connection left open never does.
    const settled = async (): Promise<number> => {
      const deadline = Date.now() + 5_000;
      let open = await sessions();
      while (open > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        open = await sessions();
      }
      return open;
    };
    try {
      await failure(migrateOnStart({ connectionString: urlFor(name) }, directory));
      expect(await settled()).toBe(0);
      writeFileSync(join(directory, '0001_broken.sql'), 'CREATE TABLE fine (id int);');
      await migrateOnStart({ connectionString: urlFor(name) }, directory);
      expect(await settled()).toBe(0);
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
      Bun.spawn(['bun', '--no-env-file', entry], {
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
      const files = await everyMigration();
      // Both answered, neither exited (a node that cannot migrate exits 1), and every
      // migration is recorded once: `name` is the primary key, so twice is an error.
      expect({
        answers,
        stillRunning: nodes.map((node) => node.exitCode === null),
        recorded: await recorded(db),
      }).toEqual({ answers: [200, 200], stillRunning: [true, true], recorded: files });
      // And the environment is in the settings once: one row, the secret sealed under the key.
      expect(await storedSettings(db, key)).toEqual({
        rows: 1,
        clientId: 'id',
        secret: 'secret',
        imported: true,
      });
    } finally {
      for (const node of nodes) node.kill();
      await Promise.all(nodes.map((node) => node.exited));
      await db.destroy();
    }
  }, 90_000);

  /**
   * The sign-in library only logs a schema it cannot use and then refuses every sign-in, so a node
   * whose library tables are not what it expects must not start as though it could (D-179).
   */
  test('a node whose sign-in tables are not what the library expects refuses to start', async () => {
    const { name, db } = await freshDatabase('drifted');
    await migrateOnStart({ connectionString: urlFor(name) });
    await sql`alter table accounts rename column scope to scope_was`.execute(db);
    const port = freePort();
    const node = Bun.spawn(['bun', '--no-env-file', join(import.meta.dir, '../index.ts')], {
      stdout: 'pipe',
      stderr: 'ignore',
      env: {
        PATH: process.env['PATH'] ?? '',
        NODE_ENV: 'development',
        PORT: String(port),
        APP_URL: `http://localhost:${String(port)}`,
        DATABASE_URL: urlFor(name),
        GITHUB_CLIENT_ID: 'id',
        GITHUB_CLIENT_SECRET: 'secret',
        ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
        MIGRATE_ON_START: 'true',
      },
    });
    try {
      const exited = await Promise.race([
        node.exited,
        Bun.sleep(30_000).then(() => 'still running'),
      ]);
      expect(exited).toBe(1);
      const said = await new Response(node.stdout).text();
      expect(said).toContain('the sign-in library cannot work on this database; exiting');
      expect(said).toContain('scope');
    } finally {
      node.kill();
      await node.exited;
      await db.destroy();
    }
  }, 60_000);

  test('a node run with MODULES=none migrates the core alone, is ready, and has no chat route', async () => {
    const { name, db } = await freshDatabase('modules-none');
    const port = freePort();
    const node = aNode(
      name,
      port,
      Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
      { MIGRATE_ON_START: 'true', MODULES: 'none' },
    );
    try {
      expect(await until(port, '/health/ready', 200)).toBe(200);
      expect(await recorded(db)).toEqual(
        (await everyMigration()).filter((file) => !file.includes('/')),
      );
      // A route of a module that is not run is the answer to any path nobody serves.
      expect(await answer(port, '/api/channels/anything')).toEqual([404, 'ROUTE_NOT_FOUND']);
      expect(await answer(port, '/api/nothing-like-it')).toEqual([404, 'ROUTE_NOT_FOUND']);
      const client = (await (
        await fetch(`http://127.0.0.1:${String(port)}/api/client`)
      ).json()) as Record<string, unknown>;
      // The public handshake does not name modules (D-250): it is a signed-in caller's `/api/me` that does.
      expect(client).not.toHaveProperty('modules');
    } finally {
      node.kill();
      await node.exited;
      await db.destroy();
    }
  }, 60_000);

  test('a node whose MODULES names a module the build does not carry exits before it listens, naming it', async () => {
    const { name, db } = await freshDatabase('modules-unknown');
    const port = freePort();
    const node = aNode(
      name,
      port,
      Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
      { MIGRATE_ON_START: 'true', MODULES: 'chat,calendar' },
    );
    try {
      const { code, said } = await exitOf(node);
      expect(code).toBe(1);
      expect(said).toContain('MODULES cannot be run; exiting');
      expect(said).toContain('calendar');
      expect(await recorded(db).catch(() => [])).toEqual([]);
    } finally {
      await db.destroy();
    }
  }, 60_000);

  test('a node that does not migrate waits for the migrations, answering busy meanwhile, then reads its settings', async () => {
    const { name, db } = await freshDatabase('waits');
    const port = freePort();
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
    const node = aNode(name, port, key);
    try {
      // Listening, and alive, with nothing to read its settings from: a request that needs them is
      // the busy answer a client retries, never a sign-in built from nothing.
      expect(await until(port, '/health', 200)).toBe(200);
      expect(await answer(port, '/api/auth/methods')).toEqual([503, 'DATABASE_UNAVAILABLE']);
      expect((await answer(port, '/health/ready'))[0]).toBe(503);
      await migrateOnStart({ connectionString: urlFor(name) });
      expect(await until(port, '/health/ready', 200)).toBe(200);
      expect(await answer(port, '/api/auth/methods')).toEqual([200, undefined]);
      expect(await storedSettings(db, key)).toEqual({
        rows: 1,
        clientId: 'id',
        secret: 'secret',
        imported: true,
      });
    } finally {
      node.kill();
      await node.exited;
      await db.destroy();
    }
  }, 60_000);

  test('a node run with MODULES=none that does not migrate is ready on a database migrated core-alone', async () => {
    const { name, db } = await freshDatabase('wait-none');
    await migrateWith(name, []);
    const port = freePort();
    const node = aNode(
      name,
      port,
      Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
      { MODULES: 'none' },
    );
    try {
      expect(await until(port, '/health/ready', 200)).toBe(200);
      expect(node.exitCode).toBeNull();
    } finally {
      node.kill();
      await node.exited;
      await db.destroy();
    }
  }, 60_000);

  test('a node that runs chat and does not migrate is not ready on that database until chat’s set is applied', async () => {
    const { name, db } = await freshDatabase('wait-chat');
    await migrateWith(name, []);
    const port = freePort();
    const node = aNode(
      name,
      port,
      Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
      { MODULES: 'chat' },
    );
    let said = '';
    const reading = (async (): Promise<void> => {
      const decoder = new TextDecoder();
      for await (const chunk of node.stdout) said += decoder.decode(chunk, { stream: true });
    })();
    try {
      await waitUntil(() => said.includes(WAITING), 'the node to say it waits for the migrations');
      expect(said).toContain('chat/');
      expect((await answer(port, '/health/ready'))[0]).toBe(503);
      expect(node.exitCode).toBeNull();
      await migrateWith(name, PRODUCT_MIGRATION_SETS);
      expect(await until(port, '/health/ready', 200)).toBe(200);
    } finally {
      node.kill();
      await node.exited;
      await reading;
      await db.destroy();
    }
  }, 60_000);

  test('a fresh server with no GitHub and no mail variable at all boots into setup mode, imports a row without GitHub, and serves', async () => {
    const { name, db } = await freshDatabase('zeroenv');
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
    const port = freePort();
    // Only what a first deployment gives: the database, the key, the address, the port.
    const node = aNode(name, port, key, { MIGRATE_ON_START: 'true' }, [
      'GITHUB_CLIENT_ID',
      'GITHUB_CLIENT_SECRET',
    ]);
    try {
      expect(await until(port, '/health/ready', 200)).toBe(200);
      expect(await bodyOf(port, '/api/auth/methods')).toEqual([
        200,
        {
          github: false,
          google: false,
          email: false,
          oidc: null,
          signUp: 'invite-only',
          password: true,
        },
      ]);
      // The button's address is a defined answer, never the library's thrown error.
      expect(await bodyOf(port, '/auth/github')).toEqual([
        404,
        {
          error: {
            code: 'ROUTE_NOT_FOUND',
            message: 'GitHub sign-in is not set up on this server.',
          },
        },
      ]);
      // The first start imported a row with no GitHub app: the wizard fills it in later.
      const row = await db
        .selectFrom('server_settings')
        .select(['github_client_id', 'github_client_secret_encrypted', 'imported_from_env_at'])
        .where('id', '=', true)
        .executeTakeFirstOrThrow();
      expect([row.github_client_id, row.github_client_secret_encrypted]).toEqual([null, null]);
      expect(row.imported_from_env_at).not.toBeNull();
      expect(node.exitCode).toBeNull();
    } finally {
      node.kill();
      await node.exited;
      await db.destroy();
    }
    const said = await new Response(node.stdout).text();
    expect(said).toContain('GitHub sign-in is off: no GitHub app is connected');
    expect(said).toContain('SETUP CODE');
  }, 60_000);

  test('a restart with another environment changes no setting, and names what it ignores, never a value', async () => {
    const { name, db } = await freshDatabase('again');
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
    const started = async (
      more: Record<string, string>,
    ): Promise<{ said: string; ready: number }> => {
      const port = freePort();
      const node = aNode(name, port, key, { MIGRATE_ON_START: 'true', ...more });
      try {
        const ready = await until(port, '/health/ready', 200);
        node.kill();
        await node.exited;
        return { said: await new Response(node.stdout).text(), ready };
      } finally {
        node.kill();
        await node.exited;
      }
    };
    try {
      const first = await started({});
      expect(first.ready).toBe(200);
      expect(first.said).toContain('the environment was copied into the server settings');

      const again = await started({
        GITHUB_CLIENT_ID: 'changed-id',
        GITHUB_CLIENT_SECRET: 'changed-secret-value',
        WORKSPACE_CREATORS: 'someone',
      });
      expect(again.ready).toBe(200);
      expect(await storedSettings(db, key)).toEqual({
        rows: 1,
        clientId: 'id',
        secret: 'secret',
        imported: true,
      });
      const line = again.said
        .split('\n')
        .find((text) => text.includes('these variables are ignored'));
      expect(JSON.parse(line ?? '{}')).toMatchObject({
        variables: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'WORKSPACE_CREATORS'],
      });
      expect(again.said).not.toContain('changed-secret-value');
      expect(again.said).not.toContain('changed-id');
      expect(
        await db
          .selectFrom('server_settings')
          .select('workspace_creators')
          .where('id', '=', true)
          .execute(),
      ).toEqual([{ workspace_creators: 'first' }]);
    } finally {
      await db.destroy();
    }
  }, 90_000);

  // The lines as an operator searches for them (`CONFIG.md`); their home is `modules/setup/setup.ts`,
  // which this layer may not import.
  const SETUP_CODE_LINE = 'SETUP CODE';
  const SETUP_CLOSED_LINE = 'setup is closed';
  test('a start of a server nobody uses writes its setup code once, after the migrations; a server with a user writes none', async () => {
    const { name, db } = await freshDatabase('setup');
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
    /**
     * One start, read as it writes, until a line containing `awaited` appears or ten seconds pass; then
     * stopped at once, and everything it wrote. Never waits on a process that will not end by itself.
     */
    const started = async (awaited: string): Promise<string> => {
      const port = freePort();
      const node = aNode(name, port, key, { MIGRATE_ON_START: 'true' });
      let said = '';
      const decoder = new TextDecoder();
      const reading = (async (): Promise<void> => {
        for await (const chunk of node.stdout) said += decoder.decode(chunk, { stream: true });
      })();
      const stop = async (): Promise<string> => {
        node.kill('SIGKILL');
        await node.exited;
        await reading;
        return `${said}${await new Response(node.stderr).text()}`;
      };
      if ((await until(port, '/health/ready', 200)) !== 200) {
        // Not ready: what the process said is the only clue, so the failure carries it.
        throw new Error(`the node never became ready:\n${await stop()}`);
      }
      const deadline = Date.now() + 10_000;
      while (!said.includes(awaited) && Date.now() < deadline) await Bun.sleep(50);
      return await stop();
    };
    const codesIn = (said: string): string[] =>
      said
        .split('\n')
        .filter((line) => line.includes(SETUP_CODE_LINE))
        .map((line) => (JSON.parse(line) as { setupCode: string }).setupCode);
    try {
      const first = await started(SETUP_CODE_LINE);
      const [code] = codesIn(first);
      expect(codesIn(first)).toHaveLength(1);
      expect(code).toMatch(/^[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){4}$/);
      // In that one line and nowhere else the process wrote.
      expect(first.split(code ?? '').length).toBe(2);
      // The migrations had run: the code line comes after the line that says so.
      expect(first.indexOf('migrations are current')).toBeLessThan(first.indexOf(SETUP_CODE_LINE));

      await db
        .insertInto('users')
        .values({ email: 'here@example.test', username: 'here', display_name: 'Here' })
        .execute();
      await db
        .updateTable('setup_state')
        .set({ code_digest: null, code_issued_at: null })
        .execute();
      const second = await started(SETUP_CLOSED_LINE);
      // It asked, and was told the door is closed: not a start killed before it asked.
      expect(second).toContain(SETUP_CLOSED_LINE);
      expect(codesIn(second)).toEqual([]);
    } finally {
      await db.destroy();
    }
  }, 90_000);

  test('waiting for the migrations ends once they are in, and says once why it waits', async () => {
    const { name, db } = await freshDatabase('until');
    const { log, lines } = aRecordingLogger();
    let done = false;
    const waiting = untilMigrated(db, log, 20).then(() => {
      done = true;
    });
    try {
      await Bun.sleep(200);
      expect(done).toBe(false);
      await migrateOnStart({ connectionString: urlFor(name) });
      await waiting;
      expect(done).toBe(true);
      const said = lines.filter(
        (line) => line['msg'] === 'waiting for the migrations before reading the settings',
      );
      expect(said).toHaveLength(1);
      expect(String(said[0]?.['reason'])).toContain('migrations not applied');
    } finally {
      await db.destroy();
    }
  });

  test('waiting for the migrations survives a database that does not answer, says so once, and ends when it does', async () => {
    const { name, db } = await freshDatabase('unreachable');
    await migrateOnStart({ connectionString: urlFor(name) });
    const { log, lines } = aRecordingLogger();
    let answering = false;
    const flaky = db.withPlugin({
      transformQuery: (args) => {
        if (!answering) throw new Error('connection refused');
        return args.node;
      },
      transformResult: (args) => Promise.resolve(args.result),
    });
    let done = false;
    const waiting = untilMigrated(flaky, log, 20).then(() => {
      done = true;
    });
    try {
      await Bun.sleep(200);
      expect(done).toBe(false);
      answering = true;
      await waiting;
      expect(done).toBe(true);
      const said = lines.filter(
        (line) => line['msg'] === 'waiting for the migrations before reading the settings',
      );
      expect(said).toHaveLength(1);
      expect(String(said[0]?.['reason'])).toBe('the database did not answer: connection refused');
    } finally {
      await db.destroy();
    }
  });

  test('waiting for the migrations is for the sets it is given: a database that has exactly those is waited on no longer', async () => {
    const { name, db } = await freshDatabase('until-partial');
    const extra = aSetOf('extra', 'extra_things');
    try {
      // The core and one set that is not the product's: neither the product's chat set nor its absence counts.
      await migrateWith(name, [extra.set]);
      const { log, lines } = aRecordingLogger();
      const outcome = await Promise.race([
        untilMigrated(db, log, 20, [extra.set]).then(() => 'resolved' as const),
        Bun.sleep(10_000).then(() => 'still waiting' as const),
      ]);
      expect({ outcome, said: lines.filter((line) => line['msg'] === WAITING) }).toEqual({
        outcome: 'resolved',
        said: [],
      });
    } finally {
      extra.remove();
      await db.destroy();
    }
  }, 60_000);

  test('waiting for the migrations keeps waiting for a set of the list that is not applied, saying so once', async () => {
    const { name, db } = await freshDatabase('until-missing');
    const extra = aSetOf('extra', 'extra_things');
    try {
      await migrateWith(name, []);
      const { log, lines } = aRecordingLogger();
      let done = false;
      const waiting = untilMigrated(db, log, 20, [extra.set]).then(() => {
        done = true;
      });
      await waitUntil(
        () => lines.some((line) => line['msg'] === WAITING),
        'the wait to say why it waits',
      );
      // Several polls have gone by once the line is written and its reason is read again.
      await Bun.sleep(100);
      expect(done).toBe(false);
      const said = lines.filter((line) => line['msg'] === WAITING);
      expect(said).toHaveLength(1);
      expect(String(said[0]?.['reason'])).toContain('extra/0001_table');
      await migrateWith(name, [extra.set]);
      await waiting;
      expect(done).toBe(true);
    } finally {
      extra.remove();
      await db.destroy();
    }
  }, 60_000);

  test('waiting for the migrations judges the history of the sets it is given: one edited after it was applied is waited on', async () => {
    const { name, db } = await freshDatabase('until-edited');
    const extra = aSetOf('extra', 'extra_things');
    try {
      await migrateWith(name, [extra.set]);
      const { rows } = await sql<{ checksum: string }>`
        select checksum from kysely_migration where name = 'extra/0001_table'`.execute(db);
      const checksum = rows[0]?.checksum ?? '';
      await sql`update kysely_migration set checksum = repeat('0', 64)
        where name = 'extra/0001_table'`.execute(db);
      const { log, lines } = aRecordingLogger();
      let done = false;
      const waiting = untilMigrated(db, log, 20, [extra.set]).then(() => {
        done = true;
      });
      await waitUntil(
        () => lines.some((line) => line['msg'] === WAITING),
        'the wait to say why it waits',
      );
      await Bun.sleep(100);
      expect(done).toBe(false);
      const said = lines.filter((line) => line['msg'] === WAITING);
      expect(said).toHaveLength(1);
      expect(String(said[0]?.['reason'])).toContain('extra/0001_table was edited');
      await sql`update kysely_migration set checksum = ${checksum}
        where name = 'extra/0001_table'`.execute(db);
      await waiting;
      expect(done).toBe(true);
    } finally {
      extra.remove();
      await db.destroy();
    }
  }, 60_000);

  test('an SMTP address no transport can be built from refuses the start and stores nothing; corrected, the next start imports it', async () => {
    const { name, db } = await freshDatabase('badsmtp');
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
    const mail = { MAIL_FROM: 'purlay@example.com', MIGRATE_ON_START: 'true' };
    try {
      const refused = await exitOf(
        aNode(name, freePort(), key, { ...mail, SMTP_URL: 'smtp://u:pa#ss@mail.example.com' }),
      );
      expect(refused.code).toBe(1);
      expect(refused.said).toContain('SMTP_URL:');
      expect(refused.said).not.toContain('pa#ss');
      // Refused before anything was written: no settings to stand in the corrected start's way.
      const { rows } = await sql<{ present: boolean }>`
        select to_regclass('server_settings') is not null as present`.execute(db);
      expect(rows[0]?.present).toBe(false);

      const port = freePort();
      const node = aNode(name, port, key, {
        ...mail,
        SMTP_URL: 'smtp://u:pa%23ss@mail.example.com',
      });
      try {
        expect(await until(port, '/health/ready', 200)).toBe(200);
      } finally {
        node.kill();
        await node.exited;
      }
      const row = await db
        .selectFrom('server_settings')
        .select('smtp_url_encrypted')
        .where('id', '=', true)
        .executeTakeFirstOrThrow();
      expect(
        await credentialCipher(key).open(
          Buffer.from(row.smtp_url_encrypted ?? '', 'base64'),
          'server_settings.smtp_url_encrypted',
        ),
      ).toBe('smtp://u:pa%23ss@mail.example.com');
    } finally {
      await db.destroy();
    }
  }, 90_000);

  test('a rotated key starts the server in setup mode, naming what to enter again and deleting nothing; the SQL CONFIG.md also gives re-imports, and GitHub signs in again', async () => {
    const { name, db } = await freshDatabase('rotated');
    const person = aGitHubPerson();
    const github = aGitHubStub(person);
    const served = github.serve(0);
    const keyOf = (): string =>
      Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
    const [before, after] = [keyOf(), keyOf()];
    const environment = {
      MIGRATE_ON_START: 'true',
      GITHUB_CLIENT_ID: GITHUB_STUB_CREDENTIALS.clientId,
      GITHUB_CLIENT_SECRET: GITHUB_STUB_CREDENTIALS.clientSecret,
      GITHUB_URL: served.url,
      GITHUB_API_URL: served.url,
    };
    try {
      // The first start seals the secret under the key it was given.
      const firstPort = freePort();
      const first = aNode(name, firstPort, before, environment);
      expect(await until(firstPort, '/health/ready', 200)).toBe(200);
      first.kill();
      await first.exited;
      const sealed = await db
        .selectFrom('server_settings')
        .select('github_client_secret_encrypted')
        .where('id', '=', true)
        .executeTakeFirstOrThrow();

      // Another key: the secret does not open. The server starts, and serves, with GitHub unset.
      const restartedPort = freePort();
      const restarted = aNode(name, restartedPort, after, environment);
      let said = '';
      try {
        expect(await until(restartedPort, '/health/ready', 200)).toBe(200);
        expect(await bodyOf(restartedPort, '/api/auth/methods')).toEqual([
          200,
          {
            github: false,
            google: false,
            email: false,
            oidc: null,
            signUp: 'invite-only',
            password: true,
          },
        ]);
        expect((await bodyOf(restartedPort, '/auth/github'))[0]).toBe(404);
        expect(restarted.exitCode).toBeNull();
      } finally {
        restarted.kill();
        await restarted.exited;
        said = `${await new Response(restarted.stdout).text()}${await new Response(restarted.stderr).text()}`;
      }
      const line = JSON.parse(
        said
          .split('\n')
          .find((text) => text.includes('cannot be opened and is treated as unset')) ?? '{}',
      ) as { level?: string; settings?: string[]; see?: string };
      expect(line.settings).toEqual(['github']);
      expect(line.see).toContain('CONFIG.md');
      expect(line.see).toContain('What stays in the environment');
      expect(said).not.toContain('exiting');
      expect(said).not.toContain(GITHUB_STUB_CREDENTIALS.clientSecret);
      expect(said).not.toContain(sealed.github_client_secret_encrypted ?? 'never');
      // Nothing was deleted: the ciphertext waits in the row for a new value to replace it.
      const kept = await db
        .selectFrom('server_settings')
        .select(['github_client_id', 'github_client_secret_encrypted'])
        .where('id', '=', true)
        .executeTakeFirstOrThrow();
      expect(kept).toEqual({
        github_client_id: GITHUB_STUB_CREDENTIALS.clientId,
        github_client_secret_encrypted: sealed.github_client_secret_encrypted,
      });

      // The operator runs what CONFIG.md says, and starts again with the new key.
      await sql.raw(recoveryInConfigDocument()).execute(db);
      // Not part of the recovery: lets the stand-in's person make an account, so the sign-in completes.
      await db
        .updateTable('server_settings')
        .set({ sign_up: 'open' })
        .where('id', '=', true)
        .execute();
      const port = freePort();
      const node = aNode(name, port, after, environment);
      try {
        expect(await until(port, '/health/ready', 200)).toBe(200);
        const origin = `http://localhost:${String(port)}`;
        const button = await fetch(`${origin}/auth/github`, { redirect: 'manual' });
        const granted = await fetch(button.headers.get('location') ?? '', { redirect: 'manual' });
        const cookie = button.headers
          .getSetCookie()
          .map((set) => set.split(';')[0] ?? '')
          .join('; ');
        const back = await fetch(granted.headers.get('location') ?? '', {
          redirect: 'manual',
          headers: { cookie },
        });
        expect(github.refusals).toEqual([]);
        expect(back.headers.get('location')).toBe(origin);
      } finally {
        node.kill();
        await node.exited;
      }
    } finally {
      served.stop();
      await db.destroy();
    }
  }, 120_000);
});
