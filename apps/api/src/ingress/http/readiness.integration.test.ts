/**
 * `/health/ready`, against databases that are wrong in each way it checks (#108).
 *
 * Each test breaks a database of its own — a clone, dropped afterwards (D-46) —
 * and requires a 503 whose body says nothing about why, with the reason in the
 * log instead (`API.md` §8).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, sql, type ClonedDatabase, type Executor } from '@purlay/db';
import { createApp } from './app';
import { aDatabaseThatMustNotBeTouched, aRecordingLogger, testDependencies } from './testing';

const clones: ClonedDatabase[] = [];

afterEach(async () => {
  for (const clone of clones.splice(0)) await clone.drop();
});

const aDatabase = async (): Promise<ClonedDatabase> => {
  const clone = await cloneIntegrationDatabase();
  clones.push(clone);
  return clone;
};

const ready = async (
  database: Executor,
): Promise<{ status: number; body: unknown; reasons: unknown[] }> => {
  const { log, lines } = aRecordingLogger();
  const response = await createApp(testDependencies({ database, log })).handle(
    new Request('https://purlay.test/health/ready'),
  );
  return {
    status: response.status,
    body: await response.json(),
    reasons: lines.filter((line) => line['msg'] === 'not ready').map((line) => line['reason']),
  };
};

describe('integration: readiness', () => {
  test('a migrated database with its collations is ready', async () => {
    const { db } = await aDatabase();
    expect(await ready(db)).toEqual({ status: 200, body: { status: 'ready' }, reasons: [] });
  });

  test('a migration not applied is not ready', async () => {
    const { db } = await aDatabase();
    await sql`delete from kysely_migration where name = '0007_message_content_limit'`.execute(db);
    const answer = await ready(db);
    expect(answer).toMatchObject({ status: 503, body: { status: 'not ready' } });
    expect(String(answer.reasons[0])).toContain('0007_message_content_limit');
  });

  test('a migration edited after it was applied is not ready', async () => {
    const { db } = await aDatabase();
    await sql`update kysely_migration set checksum = repeat('0', 64)
      where name = '0003_workspaces'`.execute(db);
    const answer = await ready(db);
    expect(answer).toMatchObject({ status: 503, body: { status: 'not ready' } });
    expect(String(answer.reasons[0])).toContain('0003_workspaces was edited after it was applied');
  });

  test('an applied migration whose file has gone is not ready', async () => {
    const { db } = await aDatabase();
    await sql`insert into kysely_migration (name, timestamp, checksum)
      values ('0099_ghost', '2099-01-01T00:00:00.000Z', repeat('1', 64))`.execute(db);
    const answer = await ready(db);
    expect(answer).toMatchObject({ status: 503, body: { status: 'not ready' } });
    expect(String(answer.reasons[0])).toContain('0099_ghost is missing');
  });

  test('migrations applied out of order are not ready', async () => {
    const { db } = await aDatabase();
    await sql`update kysely_migration set timestamp = '2099-01-01T00:00:00.000Z'
      where name = '0002_identity'`.execute(db);
    const answer = await ready(db);
    expect(answer).toMatchObject({ status: 503, body: { status: 'not ready' } });
    expect(String(answer.reasons[0])).toContain('must sort after the last applied one');
  });

  /** The state of a database the previous migrator left: no checksum column to compare. */
  test('a database from before checksums existed is ready, not accused', async () => {
    const { db } = await aDatabase();
    await sql`alter table kysely_migration drop column checksum`.execute(db);
    expect(await ready(db)).toEqual({ status: 200, body: { status: 'ready' }, reasons: [] });
  });

  test('an identifier column that does not compare byte-wise is not ready', async () => {
    const { db } = await aDatabase();
    await sql`alter table users alter column email type text collate "POSIX"`.execute(db);
    const answer = await ready(db);
    expect(answer).toMatchObject({ status: 503, body: { status: 'not ready' } });
    expect(String(answer.reasons[0])).toContain('users.email');
  });

  test('a database that does not answer is not ready, and says nothing about why', async () => {
    const answer = await ready(aDatabaseThatMustNotBeTouched());
    expect(answer).toMatchObject({ status: 503, body: { status: 'not ready' } });
    expect(String(answer.reasons[0])).toContain('did not answer');
    expect(JSON.stringify(answer.body)).not.toContain('answer');
  });
});
