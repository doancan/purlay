/**
 * `/health/ready`, against databases that are wrong in each way it checks (#108).
 *
 * Each test breaks the database inside a transaction that is rolled back (D-46) —
 * every statement used to break it is transactional in PostgreSQL — and requires a
 * 503 whose body says nothing about why, with the reason in the log instead
 * (`API.md` §8). It used to break a clone of its own for each test, and a clone is
 * seven megabytes of copying and a checkpoint to drop: eight of them were most of
 * what this file cost, and on a slow disk more than a hook's five seconds.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  sql,
  withRollback,
  type ClonedDatabase,
  type Executor,
} from '@purlay/db';
import { bundledModules, compose, type Composition } from '../../composition';
import { createApp } from './app';
import {
  aDatabaseThatMustNotBeTouched,
  aRecordingLogger,
  testDependencies,
} from '../../testing/doubles';

// A database of its own (D-228) for the tests that alter a table: the lock holds until the rollback, and on the
// shared database it deadlocks (40P01) with any file beside it that touches the table.
let own: ClonedDatabase;
beforeAll(async () => {
  own = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);

afterAll(async () => {
  await own.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

const ready = async (
  database: Executor,
  composition?: Composition,
): Promise<{ status: number; body: unknown; reasons: unknown[] }> => {
  const { log, lines } = aRecordingLogger();
  const response = await createApp(
    testDependencies({ database, log, ...(composition === undefined ? {} : { composition }) }),
  ).handle(new Request('https://purlay.test/health/ready'));
  return {
    status: response.status,
    body: await response.json(),
    reasons: lines.filter((line) => line['msg'] === 'not ready').map((line) => line['reason']),
  };
};

describe('integration: readiness', () => {
  test('a migrated database with its collations is ready', async () => {
    await withRollback(async (db) => {
      expect(await ready(db)).toEqual({ status: 200, body: { status: 'ready' }, reasons: [] });
    });
  });

  test('a migration not applied is not ready', async () => {
    await withRollback(async (db) => {
      await sql`delete from kysely_migration where name = '0007_message_content_limit'`.execute(db);
      const answer = await ready(db);
      expect(answer).toMatchObject({ status: 503, body: { status: 'not ready' } });
      expect(String(answer.reasons[0])).toContain('0007_message_content_limit');
    });
  });

  test('a migration edited after it was applied is not ready', async () => {
    await withRollback(async (db) => {
      await sql`update kysely_migration set checksum = repeat('0', 64)
        where name = '0003_workspaces'`.execute(db);
      const answer = await ready(db);
      expect(answer).toMatchObject({ status: 503, body: { status: 'not ready' } });
      expect(String(answer.reasons[0])).toContain(
        '0003_workspaces was edited after it was applied',
      );
    });
  });

  test('an applied migration whose file has gone is not ready', async () => {
    await withRollback(async (db) => {
      await sql`insert into kysely_migration (name, timestamp, checksum)
        values ('0099_ghost', '2099-01-01T00:00:00.000Z', repeat('1', 64))`.execute(db);
      const answer = await ready(db);
      expect(answer).toMatchObject({ status: 503, body: { status: 'not ready' } });
      expect(String(answer.reasons[0])).toContain('0099_ghost is missing');
    });
  });

  test('migrations applied out of order are not ready', async () => {
    await withRollback(async (db) => {
      await sql`update kysely_migration set timestamp = '2099-01-01T00:00:00.000Z'
        where name = '0002_identity'`.execute(db);
      const answer = await ready(db);
      expect(answer).toMatchObject({ status: 503, body: { status: 'not ready' } });
      expect(String(answer.reasons[0])).toContain('must sort after the last applied one');
    });
  });

  /** The state of a database the previous migrator left: no checksum column to compare. */
  test('a database from before checksums existed is ready, not accused', async () => {
    await withRollback(async (db) => {
      await sql`alter table kysely_migration drop column checksum`.execute(db);
      expect(await ready(db)).toEqual({ status: 200, body: { status: 'ready' }, reasons: [] });
    }, own.db);
  });

  test('an identifier column that does not compare byte-wise is not ready', async () => {
    await withRollback(async (db) => {
      await sql`alter table users alter column email type text collate "POSIX"`.execute(db);
      const answer = await ready(db);
      expect(answer).toMatchObject({ status: 503, body: { status: 'not ready' } });
      expect(String(answer.reasons[0])).toContain('users.email');
    }, own.db);
  });

  test('a column chat declares byte-wise, and does not, is not ready either (D-250)', async () => {
    await withRollback(async (db) => {
      await sql`alter table channels alter column name type text collate "POSIX"`.execute(db);
      const answer = await ready(db);
      expect(answer).toMatchObject({ status: 503, body: { status: 'not ready' } });
      expect(String(answer.reasons[0])).toContain('channels.name');
    }, own.db);
  });

  /**
   * The sign-in library's own check reads the catalogue on a connection of its own, which a
   * rolled-back transaction is not, so these two break a clone (D-179).
   */
  test('the sign-in library’s tables as it expects them are ready; drifted, not ready, saying why', async () => {
    const cloned = await cloneIntegrationDatabase();
    try {
      expect(await ready(cloned.db)).toEqual({
        status: 200,
        body: { status: 'ready' },
        reasons: [],
      });
      await sql`alter table verifications rename column identifier to identifier_was`.execute(
        cloned.db,
      );
      const answer = await ready(cloned.db);
      expect(answer).toMatchObject({ status: 503, body: { status: 'not ready' } });
      expect(String(answer.reasons[0])).toContain('sign-in library');
      expect(String(answer.reasons[0])).toContain('identifier');
      expect(JSON.stringify(answer.body)).not.toContain('identifier');
    } finally {
      await cloned.drop();
    }
  });

  test('a database that does not answer is not ready, and says nothing about why', async () => {
    const answer = await ready(aDatabaseThatMustNotBeTouched());
    expect(answer).toMatchObject({ status: 503, body: { status: 'not ready' } });
    expect(String(answer.reasons[0])).toContain('did not answer');
    expect(JSON.stringify(answer.body)).not.toContain('answer');
  });

  /**
   * Readiness waits for the migrations of the modules this process runs and no others (D-250): the set a
   * database has applied is the other half of the check, so a database is made to lack chat's here.
   */
  test('a process that runs chat is not ready on a database where chat’s set is not applied', async () => {
    await withRollback(async (db) => {
      await sql`delete from kysely_migration where name like 'chat/%'`.execute(db);
      const answer = await ready(db, compose(bundledModules));
      expect(answer).toMatchObject({ status: 503, body: { status: 'not ready' } });
      expect(String(answer.reasons[0])).toContain('chat/');
    });
  });

  test('a process that runs chat is ready once the set is applied', async () => {
    await withRollback(async (db) => {
      expect(await ready(db, compose(bundledModules))).toEqual({
        status: 200,
        body: { status: 'ready' },
        reasons: [],
      });
    });
  });

  test('a process that runs no module is ready on a database where chat’s set is not applied, and where it is', async () => {
    await withRollback(async (db) => {
      expect(await ready(db, compose([]))).toMatchObject({ status: 200 });
      await sql`delete from kysely_migration where name like 'chat/%'`.execute(db);
      expect(await ready(db, compose([]))).toEqual({
        status: 200,
        body: { status: 'ready' },
        reasons: [],
      });
    });
  });
});
