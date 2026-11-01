/**
 * The scheduled jobs (D-30, `SCHEMA.md` §9.2): each run is recorded whatever it ends in, so a job
 * that stopped running or keeps failing is visible; the orphan sweep takes only what nobody can
 * ever send; the storage count is put back to the bytes messages carry (I-7).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, sql, withRollback, type Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { tokenDigest } from '../../platform/tokens';
import { workspacePrefix } from '../../platform/storage';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import { aDatabaseThatMustNotBeTouched, aRecordingLogger } from '../../testing/doubles';
import { aRoom, type Room } from '../../testing/rooms';
import { aUserRow } from '../../testing/users';
import { aMemoryStore, type MemoryStore } from '../../testing/storage';
import { storeUpload } from '../attachments/uploads';
import { sendMessage } from '../messages/messages';
import {
  GITHUB_DELIVERIES_KEPT_DAYS,
  ORPHAN_AGE_MS,
  reconcileStorage,
  runJob,
  sweepEmailSignIns,
  sweepGitHubDeliveries,
  sweepLinkPreviews,
  sweepOrphans,
} from './jobs';

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
      const key = String(
        lines.find(
          (l) =>
            l['msg'] === 'an object could not be deleted from storage; it waits to be tried again',
        )?.['key'],
      );
      // Not forgotten: queued with the row's delete, for `sweep:deletions` (D-141).
      expect(
        await db
          .selectFrom('object_deletions')
          .select(['storage_key', 'attempts'])
          .where('storage_key', 'like', `${workspacePrefix(room.workspaceId)}%`)
          .execute(),
      ).toEqual([{ storage_key: key, attempts: 1 }]);
      expect(store.keys()).toEqual([key]);
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

describe('integration: the delivery sweep (D-134 §5)', () => {
  test('forgets the ids older than the days they are kept; the one exactly that old stays', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const feed = crypto.randomUUID();
      await db
        .insertInto('github_repo_feeds')
        .values({
          id: feed,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          repository_full_name: 'acme/api',
          events: ['push'],
          secret_encrypted: 'sealed',
        })
        .execute();
      const kept = NOW.getTime() - GITHUB_DELIVERIES_KEPT_DAYS * 24 * 60 * 60 * 1000;
      await db
        .insertInto('github_deliveries')
        .values([
          { feed_id: feed, delivery_id: 'older', received_at: new Date(kept - 1) },
          { feed_id: feed, delivery_id: 'exactly', received_at: new Date(kept) },
          { feed_id: feed, delivery_id: 'newer', received_at: NOW },
        ])
        .execute();
      expect(await sweepGitHubDeliveries({ database: db, clock })).toEqual({ removed: 1 });
      const left = await db
        .selectFrom('github_deliveries')
        .select('delivery_id')
        .where('feed_id', '=', feed)
        .orderBy('delivery_id')
        .execute();
      expect(left.map((row) => row.delivery_id)).toEqual(['exactly', 'newer']);
    });
  });
});

describe('integration: the GitHub App’s sweep (D-246)', () => {
  test('forgets its deliveries past the days kept and the trips that expired, and nothing live', async () => {
    await withRollback(async (db) => {
      const days = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);
      const digest = (n: number): string => n.toString(16).padStart(64, '0');
      await db
        .insertInto('github_app_deliveries')
        .values([
          { delivery_id: 'app-old', body_digest: digest(1), received_at: days(31) },
          { delivery_id: 'app-exactly', body_digest: digest(2), received_at: days(30) },
          { delivery_id: 'app-new', body_digest: digest(3), received_at: days(1) },
        ])
        .execute();
      const person = await aUserRow(db, 'sweeper');
      await db
        .insertInto('github_app_handshakes')
        .values(
          [-1, 0, 5].map((minutes, n) => ({
            state_digest: digest(100 + n),
            user_id: person.userId,
            workspace_id: null,
            purpose: 'authorize',
            verifier_encrypted: 'sealed',
            expires_at: new Date(NOW.getTime() + minutes * 60_000),
          })),
        )
        .execute();
      // The delivery past its days, and the two trips that were over at the instant of the sweep.
      expect(await sweepGitHubDeliveries({ database: db, clock })).toEqual({ removed: 3 });
      const deliveries = await db
        .selectFrom('github_app_deliveries')
        .select('delivery_id')
        .where('received_at', '>=', days(40))
        .orderBy('delivery_id')
        .execute();
      expect(deliveries.map((row) => row.delivery_id)).toEqual(['app-exactly', 'app-new']);
      const trips = await db
        .selectFrom('github_app_handshakes')
        .select('state_digest')
        .where('user_id', '=', person.userId)
        .execute();
      expect(trips).toEqual([{ state_digest: digest(102) }]);
    });
  });
});

describe('integration: the sign-in mail sweep', () => {
  test('takes every verification row expired more than a day ago, whatever its prefix, and counters a day closed; nothing live', async () => {
    await withRollback(async (db) => {
      const now = new Date('2026-10-14T12:00:00.000Z');
      const hoursAgo = (hours: number): Date => new Date(now.getTime() - hours * 3_600_000);
      // The library's link rows, by when they expired; a password reset's row, long expired; and a
      // value that is not JSON, which the sweep has no reason to read.
      await db
        .insertInto('verifications')
        .values([
          ...[24.01, 30, 23.99, 0, -0.25].map((hours, n) => ({
            identifier: `magic-link:sweep-${String(n)}`,
            value: JSON.stringify({ type: 'magic-link', email: `s${String(n)}@example.test` }),
            expires_at: hoursAgo(hours),
          })),
          { identifier: 'reset-password:sweep-old', value: 'a-user-id', expires_at: hoursAgo(48) },
          { identifier: 'reset-password:sweep-new', value: 'a-user-id', expires_at: hoursAgo(23) },
          // The state of an abandoned GitHub round trip, which holds a PKCE verifier, and a row of no prefix.
          { identifier: 'sweepstate-old', value: '{"codeVerifier":"x"}', expires_at: hoursAgo(48) },
          { identifier: 'sweepstate-new', value: '{"codeVerifier":"x"}', expires_at: hoursAgo(1) },
          { identifier: 'other:sweep-old', value: '{not json', expires_at: hoursAgo(48) },
          { identifier: 'other:sweep-new', value: '{not json', expires_at: hoursAgo(-1) },
        ])
        .execute();
      // Counters, the library's (a client address and a path) and Purlay's, by `last_request`.
      await db
        .insertInto('rate_limits')
        .values(
          [24.01, 30, 23.99, -1].map((hours, n) => ({
            key: `sweep-${String(n)}|/sign-in/email`,
            count: 1,
            last_request: String(hoursAgo(hours).getTime()),
          })),
        )
        .execute();
      expect(await sweepEmailSignIns({ database: db, clock: fixedClock(now) })).toEqual({
        removed: 4 + 3,
      });
      const links = await db
        .selectFrom('verifications')
        .select('identifier')
        .where('identifier', 'like', '%sweep%')
        .orderBy('identifier')
        .execute();
      expect(links.map((row) => row.identifier)).toEqual([
        'magic-link:sweep-2',
        'magic-link:sweep-3',
        'magic-link:sweep-4',
        'other:sweep-new',
        'reset-password:sweep-new',
        'sweepstate-new',
      ]);
      const counters = await db
        .selectFrom('rate_limits')
        .select('key')
        .where('key', 'like', 'sweep-%')
        .orderBy('key')
        .execute();
      expect(counters.map((row) => row.key)).toEqual([
        'sweep-2|/sign-in/email',
        'sweep-3|/sign-in/email',
      ]);
    });
  });

  test('takes a native sign-in code only once it is MORE than a day past its end: exactly a day is kept, a millisecond more is taken (D-191)', async () => {
    await withRollback(async (db) => {
      const now = new Date('2026-10-26T12:00:00.000Z');
      const mine = await aUserRow(db, 'native-edge-mine');
      const theirs = await aUserRow(db, 'native-edge-theirs');
      const day = 24 * 3_600_000;
      const make = async (
        who: { userId: string },
        name: string,
        expiresAgo: number,
        spent = false,
      ): Promise<void> => {
        await db
          .insertInto('native_authorizations')
          .values({
            id: messageId(now),
            user_id: who.userId,
            code_digest: await tokenDigest(name),
            challenge: 'c'.repeat(43),
            created_at: new Date(now.getTime() - expiresAgo - 120_000),
            expires_at: new Date(now.getTime() - expiresAgo),
            spent_at: spent ? new Date(now.getTime() - expiresAgo - 60_000) : null,
          })
          .execute();
      };
      await make(mine, 'exactly-a-day', day);
      await make(mine, 'a-millisecond-more', day + 1);
      // Spent or not makes no difference to the sweep: the end is what it reads, and a spent code's session is its own.
      await make(mine, 'spent-long-ago', day + 1000, true);
      await make(mine, 'spent-just-now', 1000, true);
      // Somebody else's live code is nobody's to sweep.
      await make(theirs, 'theirs-live', -60_000);
      const swept = await sweepEmailSignIns({ database: db, clock: fixedClock(now) });
      expect(swept.removed).toBe(2);
      const left = await db
        .selectFrom('native_authorizations')
        .select('code_digest')
        .where('user_id', 'in', [mine.userId, theirs.userId])
        .execute();
      const kept = left.map((row) => row.code_digest);
      for (const name of ['exactly-a-day', 'spent-just-now', 'theirs-live']) {
        expect(kept).toContain(await tokenDigest(name));
      }
      for (const name of ['a-millisecond-more', 'spent-long-ago']) {
        expect(kept).not.toContain(await tokenDigest(name));
      }
    });
  });

  test('takes the native sign-in codes a day past their end, and not before (D-191)', async () => {
    await withRollback(async (db) => {
      const now = new Date('2026-10-26T12:00:00.000Z');
      const person = await aUserRow(db, 'native-sweep');
      const day = 24 * 3_600_000;
      const make = async (name: string, expiresAgo: number): Promise<void> => {
        await db
          .insertInto('native_authorizations')
          .values({
            id: messageId(now),
            user_id: person.userId,
            code_digest: await tokenDigest(name),
            challenge: 'c'.repeat(43),
            created_at: new Date(now.getTime() - expiresAgo - 120_000),
            expires_at: new Date(now.getTime() - expiresAgo),
          })
          .execute();
      };
      // Ended a day and a second ago; ended a second short of a day ago; and live.
      await make('ended-long', day + 1000);
      await make('ended-recently', day - 1000);
      await make('live', -60_000);
      const swept = await sweepEmailSignIns({ database: db, clock: fixedClock(now) });
      expect(swept.removed).toBe(1);
      const left = await db
        .selectFrom('native_authorizations')
        .select('code_digest')
        .where('user_id', '=', person.userId)
        .execute();
      expect(left.map((row) => row.code_digest).sort()).toEqual(
        [await tokenDigest('ended-recently'), await tokenDigest('live')].sort(),
      );
    });
  });

  test('takes the invitation passports a day past their hour or their use, and not before (D-179 §5)', async () => {
    await withRollback(async (db) => {
      const now = new Date('2026-10-14T12:00:00.000Z');
      const owner = await aUserRow(db, 'passport-owner');
      const { id: workspaceId } = await db
        .insertInto('workspaces')
        .values({ name: 'Sweep', slug: `sweep-${crypto.randomUUID().slice(0, 6)}` })
        .returning('id')
        .executeTakeFirstOrThrow();
      const invitationId = messageId(now);
      await db
        .insertInto('workspace_invitations')
        .values({
          id: invitationId,
          workspace_id: workspaceId,
          token_hash: 'd'.repeat(64),
          created_by: owner.userId,
          created_at: new Date(now.getTime() - 3 * 24 * 3_600_000),
          expires_at: new Date(now.getTime() + 24 * 3_600_000),
        })
        .execute();
      const day = 24 * 3_600_000;
      const make = async (
        name: string,
        expiresAgo: number,
        consumedAgo: number | null,
      ): Promise<string> => {
        const id = messageId(now);
        await db
          .insertInto('invitation_passports')
          .values({
            id,
            invitation_id: invitationId,
            kind: 'github',
            cookie_digest: await tokenDigest(name),
            expires_at: new Date(now.getTime() - expiresAgo),
            consumed_at: consumedAgo === null ? null : new Date(now.getTime() - consumedAgo),
          })
          .execute();
        return name;
      };
      // Expired a day and a second ago; spent a day and a second ago; each one second short of that;
      // and one live.
      await make('expired-long', day + 1000, null);
      await make('spent-long', 3_600_000, day + 1000);
      await make('expired-recently', day - 1000, null);
      await make('spent-recently', day - 1000, day - 1000);
      await make('live', -3_600_000, null);
      const remaining = async (): Promise<string[]> =>
        (
          await db
            .selectFrom('invitation_passports')
            .select('cookie_digest')
            .where('invitation_id', '=', invitationId)
            .orderBy('cookie_digest')
            .execute()
        )
          .map((row) => row.cookie_digest ?? '')
          .sort();
      const names = ['expired-long', 'spent-long', 'expired-recently', 'spent-recently', 'live'];
      const digestOf = new Map(
        await Promise.all(names.map(async (name) => [await tokenDigest(name), name] as const)),
      );
      const swept = await sweepEmailSignIns({ database: db, clock: fixedClock(now) });
      expect(swept.removed).toBe(2);
      expect((await remaining()).map((digest) => digestOf.get(digest)).sort()).toEqual(
        ['expired-recently', 'live', 'spent-recently'].sort(),
      );
    });
  });

  test('takes the administrator’s address link once it no longer opens, and not before (D-179 §4.3)', async () => {
    await withRollback(async (db) => {
      const now = new Date('2026-10-14T12:00:00.000Z');
      const admin = await aUserRow(db, 'admin');
      await db
        .insertInto('admin_email_verification')
        .values({
          user_id: admin.userId,
          email: admin.email,
          token_digest: 'a'.repeat(64),
          issued_at: new Date(now.getTime() - 24 * 3_600_000 + 1),
        })
        .execute();
      const left = async (): Promise<number> =>
        (
          await db
            .selectFrom('admin_email_verification')
            .select('user_id')
            .where('user_id', '=', admin.userId)
            .execute()
        ).length;
      await sweepEmailSignIns({ database: db, clock: fixedClock(now) });
      expect(await left()).toBe(1);
      expect(
        await sweepEmailSignIns({ database: db, clock: fixedClock(new Date(now.getTime() + 1)) }),
      ).toEqual({ removed: 1 });
      expect(await left()).toBe(0);
    });
  });
});
