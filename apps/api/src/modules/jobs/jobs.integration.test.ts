/**
 * The scheduled jobs (D-30, `SCHEMA.md` §9.2): each run is recorded whatever it ends in, so a job
 * that stopped running or keeps failing is visible; the orphan sweep takes only what nobody can
 * ever send; the storage count is put back to the bytes messages carry (I-7).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, sql, withRollback, type Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import { aDatabaseThatMustNotBeTouched, aRecordingLogger } from '../../testing/doubles';
import { aRoom, type Room } from '../../testing/rooms';
import { aMemoryStore, type MemoryStore } from '../../testing/storage';
import { storeUpload } from '../attachments/uploads';
import { sendMessage } from '../messages/messages';
import { ORPHAN_AGE_MS, reconcileStorage, runJob, sweepLinkPreviews, sweepOrphans } from './jobs';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
let tick = 0;
const anId = (): string => messageId(new Date(NOW.getTime() - 60_000 + (tick += 1)));

interface JobRow {
  readonly last_started_at: Date | null;
  readonly last_success_at: Date | null;
  readonly last_duration_ms: number | null;
  readonly last_error: string | null;
  readonly consecutive_failures: number;
}

const record = async (db: Executor, name: string): Promise<JobRow | undefined> =>
  await db
    .selectFrom('job_runs')
    .select([
      'last_started_at',
      'last_success_at',
      'last_duration_ms',
      'last_error',
      'consecutive_failures',
    ])
    .where('job_name', '=', name)
    .executeTakeFirst();

describe('integration: a job’s run is recorded', () => {
  test('a database that fails before the job could start is still said in the log, and thrown on', async () => {
    // What `jobs:first` meets when the scheduler starts against a database not ready yet: the
    // only trace used to be the scheduler's bare exit code.
    const { log, lines } = aRecordingLogger();
    const down = new Error('the database is not ready');
    let ran = false;
    const outcome = await runJob(
      { database: aDatabaseThatMustNotBeTouched(down), clock, log },
      'sweep:test',
      () => {
        ran = true;
        return Promise.resolve({});
      },
    ).catch((error: unknown) => error);
    expect(outcome).toBe(down);
    expect(ran).toBe(false);
    expect(
      lines.some(
        (line) => line['msg'] === 'a scheduled job failed' && line['job'] === 'sweep:test',
      ),
    ).toBe(true);
  });

  test('a failure that cannot be recorded is still said, and the job’s own error is the one thrown', async () => {
    await withRollback(async (db) => {
      const { log, lines } = aRecordingLogger();
      // The job breaks the transaction it shares with the record, so recording the failure fails too.
      const outcome = await runJob({ database: db, clock, log }, 'sweep:test', async () => {
        await sql`select 1 / 0`.execute(db);
        return {};
      }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
      expect(outcome).toContain('division by zero');
      const said = lines.map((line) => line['msg']);
      expect(said).toContain('a scheduled job failed');
      expect(said).toContain('a failed job could not be recorded');
    });
  });

  test('a success: when it started and ended, how long, and no failures counted', async () => {
    await withRollback(async (db) => {
      const { log } = aRecordingLogger();
      await runJob({ database: db, clock, log }, 'sweep:test', () => Promise.resolve({ done: 1 }));
      expect(await record(db, 'sweep:test')).toMatchObject({
        last_started_at: NOW,
        last_success_at: NOW,
        last_duration_ms: 0,
        last_error: null,
        consecutive_failures: 0,
      });
    });
  });

  test('a failure: its message, kept short, counted, the last success kept, and thrown on', async () => {
    await withRollback(async (db) => {
      const { log, lines } = aRecordingLogger();
      const dependencies = { database: db, clock, log };
      await runJob(dependencies, 'sweep:test', () => Promise.resolve({}));
      const later = fixedClock(new Date(NOW.getTime() + 86_400_000));
      let thrown: unknown = null;
      for (let run = 0; run < 2; run += 1) {
        await runJob({ ...dependencies, clock: later }, 'sweep:test', () =>
          Promise.reject(new Error(`the bucket is down ${'x'.repeat(2_000)}`)),
        ).catch((error: unknown) => {
          thrown = error;
        });
      }
      expect(thrown).toBeInstanceOf(Error);
      const row = await record(db, 'sweep:test');
      expect(row).toMatchObject({ last_success_at: NOW, consecutive_failures: 2 });
      expect(row?.last_error?.startsWith('the bucket is down')).toBe(true);
      expect(row?.last_error?.length).toBeLessThanOrEqual(500);
      expect(
        lines.some((l) => l['level'] === 'error' && l['msg'] === 'a scheduled job failed'),
      ).toBe(true);
    });
  });
});

const upload = async (
  db: Executor,
  store: MemoryStore,
  room: Room,
  bytes: number,
): Promise<string> => {
  const alice = room.members['alice'];
  if (alice === undefined) throw new Error('room');
  const id = anId();
  await storeUpload(
    { atomically: atomicallyOn(db), storage: store, log: aRecordingLogger().log },
    await requireWorkspaceMembership(db, alice.userId, room.workspaceId),
    { id, name: `${id}.txt`, bytes: new Uint8Array(bytes).fill(1) },
  );
  return id;
};

const age = async (db: Executor, id: string, ms: number): Promise<void> => {
  await db
    .updateTable('attachments')
    .set({ created_at: new Date(NOW.getTime() - ms) })
    .where('id', '=', id)
    .execute();
};

describe('integration: the orphan sweep', () => {
  test('takes unsent uploads older than a day, row and objects; the young and the sent stay', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const store = aMemoryStore();
      const old = await upload(db, store, room, 3);
      const young = await upload(db, store, room, 3);
      const sent = await upload(db, store, room, 3);
      await age(db, old, ORPHAN_AGE_MS + 1);
      await age(db, young, ORPHAN_AGE_MS - 1);
      await age(db, sent, ORPHAN_AGE_MS + 1);
      const alice = room.members['alice'];
      if (alice === undefined) throw new Error('room');
      await sendMessage(db, clock, alice.context, {
        id: anId(),
        content: 'x',
        attachmentIds: [sent],
      });
      const before = store.keys().length;

      const swept = await sweepOrphans({
        database: db,
        clock,
        storage: store,
        log: aRecordingLogger().log,
      });
      expect(swept).toEqual({ removed: 1, leftBehind: 0 });
      const left = await db
        .selectFrom('attachments')
        .select('id')
        .where('id', 'in', [old, young, sent])
        .orderBy('id')
        .execute();
      expect(left.map((row) => row.id)).toEqual([young, sent]);
      expect(store.keys()).toHaveLength(before - 1);
    });
  });

  test('an object that cannot be deleted is said, by key, and counted', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const store = aMemoryStore();
      const old = await upload(db, store, room, 3);
      await age(db, old, ORPHAN_AGE_MS + 1);
      store.failing('delete', new Error('cannot delete'));
      const { log, lines } = aRecordingLogger();
      const swept = await sweepOrphans({ database: db, clock, storage: store, log });
      expect(swept).toEqual({ removed: 1, leftBehind: 1 });
      expect(lines.some((l) => l['msg'] === 'an upload’s object was left behind')).toBe(true);
    });
  });
});

describe('integration: reconciling the storage count (I-7)', () => {
  test('puts each count back to the bytes its messages carry, and says which moved', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const store = aMemoryStore();
      const sent = await upload(db, store, room, 7);
      await upload(db, store, room, 100); // unsent: not stored bytes yet
      const alice = room.members['alice'];
      if (alice === undefined) throw new Error('room');
      await sendMessage(db, clock, alice.context, {
        id: anId(),
        content: 'x',
        attachmentIds: [sent],
      });
      const steady = await aRoom(db, ['bob']);
      await db
        .updateTable('workspaces')
        .set({ storage_used_bytes: '999' })
        .where('id', '=', room.workspaceId)
        .execute();

      const { log, lines } = aRecordingLogger();
      const result = await reconcileStorage({ database: db, log });
      const counts = await db
        .selectFrom('workspaces')
        .select(['id', 'storage_used_bytes'])
        .where('id', 'in', [room.workspaceId, steady.workspaceId])
        .execute();
      expect(Object.fromEntries(counts.map((w) => [w.id, Number(w.storage_used_bytes)]))).toEqual({
        [room.workspaceId]: 7,
        [steady.workspaceId]: 0,
      });
      expect(result.corrected).toBeGreaterThanOrEqual(1);
      const moved = lines.find((l) => l['workspaceId'] === room.workspaceId);
      expect(moved).toMatchObject({ level: 'warn', before: '999', after: '7' });
      expect(lines.some((l) => l['workspaceId'] === steady.workspaceId)).toBe(false);
    });
  });
});

describe('integration: the link-preview sweep (D-23)', () => {
  test('takes the previews past their expiry, at it included; the fresh stay', async () => {
    await withRollback(async (db) => {
      const preview = (
        hash: string,
        expires: Date,
      ): { url_hash: string; url: string; payload: string; expires_at: Date } => ({
        url_hash: hash,
        url: `https://github.com/acme/${hash}`,
        payload: JSON.stringify({ kind: 'missing' }),
        expires_at: expires,
      });
      await db
        .insertInto('link_previews')
        .values([
          preview('sweep-past', new Date(NOW.getTime() - 1)),
          preview('sweep-at', NOW),
          preview('sweep-fresh', new Date(NOW.getTime() + 1)),
        ])
        .execute();
      expect(await sweepLinkPreviews({ database: db, clock })).toEqual({ removed: 2 });
      const left = await db
        .selectFrom('link_previews')
        .select('url_hash')
        .where('url_hash', 'like', 'sweep-%')
        .execute();
      expect(left.map((row) => row.url_hash)).toEqual(['sweep-fresh']);
    });
  });
});
