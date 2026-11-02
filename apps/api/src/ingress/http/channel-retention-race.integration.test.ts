/**
 * A channel's retention against what happens at the same moment (D-225), on a cloned database with real
 * connections — inside the harness's one transaction nothing races (D-46, D-77):
 *
 * - **an owner keeps a channel forever while the purge runs**: the change is answered without waiting on
 *   the purge — they share no lock — and is the rule from the purge's next batch on; only the batch that
 *   had already read the old rule finishes by it, as if the change had come a moment later;
 * - **a purge interrupted mid-batch** writes nothing of that batch — no message gone, no counter taken
 *   back — says on the trail what had committed and that it is incomplete, and the next run, by the same
 *   per-channel rule, finishes it.
 *
 * A trigger that waits on an advisory lock the test holds keeps the batch open, so the outcome is not
 * left to scheduling.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  sql,
  type ClonedDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import { messageId } from '@purlay/types';
import { DAY_MS, fixedClock } from '../../platform/clock';
import { SESSION_COOKIE } from '../../platform/cookies';
import { aRecordingLogger, NOW, testDependencies } from '../../testing/doubles';
import { aRoom, counters, type Room } from '../../testing/rooms';
import { aSession } from '../../testing/signed-in';
import { aMemoryStore } from '../../testing/storage';
import { purgeRetention, purgeWorkspace } from '../../modules/retention/purge';
import { createApp } from './app';

let cloned: ClonedDatabase;

/** The advisory lock a reply's delete waits on while the test holds it. */
const HELD = 8393;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  await sql`
    create function wait_reply_delete() returns trigger language plpgsql as
    $$ begin
      if old.parent_id is not null then
        perform pg_advisory_lock_shared(8393);
        perform pg_advisory_unlock_shared(8393);
      end if;
      return old;
    end $$
  `.execute(cloned.db);
  await sql`
    create function refuse_marked() returns trigger language plpgsql as
    $$ begin if old.content = 'refused' then raise exception 'the disk said no'; end if; return old; end $$
  `.execute(cloned.db);
}, CLONE_HOOK_MS);

afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

const DAYS = 30;
const clock = fixedClock(NOW);

const member = (room: Room, name: string): NonNullable<Room['members'][string]> => {
  const found = room.members[name];
  if (found === undefined) throw new Error(`no member ${name}`);
  return found;
};

let tick = 0;
/** A message `days` old in the room's channel, a reply under `parentId`. */
const written = async (
  room: Room,
  days: number,
  content = 'words',
  parentId?: string,
): Promise<string> => {
  tick += 1;
  const at = new Date(NOW.getTime() - days * DAY_MS - tick);
  const id = messageId(at);
  await cloned.db
    .insertInto('messages')
    .values({
      id,
      channel_id: room.channelId,
      workspace_id: room.workspaceId,
      sender_id: member(room, 'ada').userId,
      content,
      created_at: at,
      ...(parentId === undefined ? {} : { parent_id: parentId }),
    })
    .execute();
  return id;
};

const present = async (ids: readonly string[]): Promise<string[]> =>
  (await cloned.db.selectFrom('messages').select('id').where('id', 'in', ids).execute())
    .map((row) => row.id)
    .sort();

const purge = async (room: Room): ReturnType<typeof purgeWorkspace> =>
  await purgeWorkspace(
    { database: cloned.db, clock, log: aRecordingLogger().log, storage: aMemoryStore() },
    { id: room.workspaceId, retentionDays: DAYS },
  );

const anOwnersRoom = async (): Promise<{ room: Room; cookie: string }> => {
  const room = await aRoom(cloned.db, ['ada', 'bob']);
  await cloned.db
    .updateTable('workspaces')
    .set({ retention_days: DAYS })
    .where('id', '=', room.workspaceId)
    .execute();
  await cloned.db
    .updateTable('workspace_members')
    .set({ role: 'owner' })
    .where('workspace_id', '=', room.workspaceId)
    .where('user_id', '=', member(room, 'ada').userId)
    .execute();
  const { token } = await aSession(cloned.db, clock, member(room, 'ada').userId, 30);
  return { room, cookie: `${SESSION_COOKIE}=${token}` };
};

describe('integration: a channel’s retention against the purge at the same moment', () => {
  test('kept forever while the purge runs: answered at once, and the rule from the next batch on', async () => {
    const { room, cookie } = await anOwnersRoom();
    const root = await written(room, 100);
    const reply = await written(room, 95, 'an old answer', root);
    const alone = await written(room, 100);
    const app = createApp(testDependencies({ database: cloned.db, clock }));

    await sql`create trigger hold before delete on messages for each row execute function wait_reply_delete()`.execute(
      cloned.db,
    );
    let purged: Awaited<ReturnType<typeof purgeWorkspace>> | undefined;
    try {
      await cloned.db.connection().execute(async (holder) => {
        await sql`select pg_advisory_lock(${HELD})`.execute(holder);
        try {
          const running = purge(room);
          // The positive condition: the purge's first batch is deleting the reply, held open.
          for (let waited = 0; ; waited += 1) {
            const { rows } = await sql<{ n: number }>`
              select count(*)::int as n from pg_stat_activity
              where wait_event_type = 'Lock' and wait_event = 'advisory'
                and datname = current_database()
            `.execute(holder);
            if ((rows[0]?.n ?? 0) > 0) break;
            if (waited > 500) throw new Error('the purge never reached the reply');
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          // While that batch holds its locks, the owner keeps the channel forever: answered now.
          const answer = await app.handle(
            new Request(`https://purlay.test/api/channels/${room.channelId}/retention`, {
              method: 'PUT',
              headers: {
                cookie,
                origin: 'https://purlay.test',
                'content-type': 'application/json',
              },
              body: JSON.stringify({ keepsAtLeast: 'forever' }),
            }),
          );
          expect(answer.status).toBe(200);
          await sql`select pg_advisory_unlock(${HELD})`.execute(holder);
          purged = await running;
        } finally {
          await sql`select pg_advisory_unlock_all()`.execute(holder);
        }
      });
    } finally {
      await sql`drop trigger hold on messages`.execute(cloned.db);
    }
    // The reply's batch had read the old rule and finished by it; the roots' batch read the new one.
    expect(purged).toMatchObject({ deleted: 1, tombstoned: 0 });
    expect(await present([root, reply, alone])).toEqual([root, alone].sort());
  });

  test('interrupted mid-batch: nothing of the batch is written, the trail says so, and the next run finishes it', async () => {
    const { room } = await anOwnersRoom();
    await cloned.db
      .updateTable('channels')
      .set({ min_retention_days: 90 })
      .where('id', '=', room.channelId)
      .execute();
    const past = await written(room, 100, 'refused');
    const pastToo = await written(room, 120);
    const inside = await written(room, 60);
    await cloned.db
      .updateTable('channel_members')
      .set({ unread_count: 3 })
      .where('channel_id', '=', room.channelId)
      .execute();

    await sql`create trigger refuse before delete on messages for each row execute function refuse_marked()`.execute(
      cloned.db,
    );
    let failure: unknown = null;
    try {
      await purgeRetention({
        database: cloned.db,
        clock,
        log: aRecordingLogger().log,
        storage: aMemoryStore(),
      });
    } catch (error) {
      failure = error;
    } finally {
      await sql`drop trigger refuse on messages`.execute(cloned.db);
    }
    expect(String(failure)).toContain(room.workspaceId);
    // The batch held both old messages: neither went, and nobody's count was taken back.
    expect(await present([past, pastToo, inside])).toEqual([past, pastToo, inside].sort());
    expect(await counters(cloned.db, room, member(room, 'bob').userId)).toMatchObject({
      unread: 3,
    });
    const trail = async (): Promise<unknown[]> =>
      (
        await cloned.db
          .selectFrom('audit_log')
          .select('metadata')
          .where('workspace_id', '=', room.workspaceId)
          .where('action', '=', 'retention.purged')
          .execute()
      ).map((row) => row.metadata);
    expect(await trail()).toEqual([{ days: '30', messages: '0', files: '0', incomplete: 'true' }]);

    // Run again, as the scheduler would the next night or after a restart: finished, by the same rule.
    await purge(room);
    expect(await present([past, pastToo, inside])).toEqual([inside]);
    expect(await counters(cloned.db, room, member(room, 'bob').userId)).toMatchObject({
      unread: 1,
    });
    // Both lines at the test's one instant, so nothing orders them: the second run's is beside the first.
    const lines = await trail();
    expect(lines).toHaveLength(2);
    expect(lines).toContainEqual({ days: '30', messages: '2', files: '0' });
  });
});
