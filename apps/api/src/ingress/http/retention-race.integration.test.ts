/**
 * The purge against what happens at the same moment (D-139 §2), on a cloned database with real
 * connections — inside the harness's one transaction nothing races (D-46, D-77):
 *
 * - **two runs at once** (the scheduler's night and a first run at start, D-30) take different rows,
 *   and the workspace's storage count comes down by each file's bytes once (I-7);
 * - **a reply to a root the purge takes** is the root not found — `404` — never a `500` from the
 *   reference the database refused: the reply is held between reading its root and inserting, on a lock
 *   the test holds, until the database says it is waiting there;
 * - **a reply into a thread the purge is thinning, and a read of a message it is taking,** each finish
 *   — neither side is chosen as a deadlock's victim, because the purge never waits on a message row.
 *
 * Triggers that sleep or wait on a lock hold the window open, so the outcome is not left to scheduling.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, sql, type ClonedDatabase } from '@purlay/db';
import { messageId } from '@purlay/types';
import { DAY_MS, fixedClock } from '../../platform/clock';
import { aRecordingLogger, NOW, testDependencies } from '../../testing/doubles';
import { aRoom, type Room } from '../../testing/rooms';
import { aMemoryStore } from '../../testing/storage';
import { SESSION_COOKIE } from '../../platform/cookies';
import { aSession } from '../../testing/signed-in';
import { createApp } from './app';
import { purgeRetention, purgeWorkspace } from '../../modules/retention/purge';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  await sql`
    create function hold_window() returns trigger language plpgsql as
    $$ begin perform pg_sleep(0.3); return old; end $$
  `.execute(cloned.db);
  // A reply's insert waits here while the test holds lock 8391: after its root was read, before the
  // reference to it is checked.
  await sql`
    create function wait_insert() returns trigger language plpgsql as
    $$ begin perform pg_advisory_lock_shared(8391); perform pg_advisory_unlock_shared(8391); return new; end $$
  `.execute(cloned.db);
  await sql`
    create function hold_delete() returns trigger language plpgsql as
    $$ begin perform pg_sleep(0.3); return old; end $$
  `.execute(cloned.db);
});

afterAll(async () => {
  await cloned.drop();
});

const DAYS = 30;
const OLD = new Date(NOW.getTime() - (DAYS + 1) * DAY_MS);
const clock = fixedClock(NOW);

const member = (room: Room, name: string): NonNullable<Room['members'][string]> => {
  const found = room.members[name];
  if (found === undefined) throw new Error(`no member ${name}`);
  return found;
};

let tick = 0;
const oldMessage = async (room: Room): Promise<string> => {
  tick += 1;
  const at = new Date(OLD.getTime() + tick);
  const id = messageId(at);
  await cloned.db
    .insertInto('messages')
    .values({
      id,
      channel_id: room.channelId,
      workspace_id: room.workspaceId,
      sender_id: member(room, 'ada').userId,
      content: 'old',
      created_at: at,
    })
    .execute();
  return id;
};

describe('integration: the purge against what happens at the same moment', () => {
  test('two runs at once: every old message goes once, and each file’s bytes come off once', async () => {
    const room = await aRoom(cloned.db, ['ada', 'bob']);
    const storage = aMemoryStore();
    for (let n = 0; n < 3; n += 1) {
      const message = await oldMessage(room);
      tick += 1;
      const id = messageId(new Date(NOW.getTime() + tick));
      const key = `w/${room.workspaceId}/${id}`;
      await storage.put(key, new Uint8Array([1]), 'application/octet-stream');
      await cloned.db
        .insertInto('attachments')
        .values({
          id,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          message_id: message,
          uploader_id: member(room, 'ada').userId,
          storage_key: key,
          file_name: 'a.bin',
          mime_type: 'application/octet-stream',
          size_bytes: '100',
        })
        .execute();
    }
    await cloned.db
      .updateTable('workspaces')
      .set({ storage_used_bytes: '1300', retention_days: DAYS })
      .where('id', '=', room.workspaceId)
      .execute();

    const run = async (): ReturnType<typeof purgeWorkspace> =>
      await purgeWorkspace(
        { database: cloned.db, clock, log: aRecordingLogger().log, storage },
        { id: room.workspaceId, retentionDays: DAYS },
      );
    await sql`create trigger hold before delete on attachments for each row execute function hold_window()`.execute(
      cloned.db,
    );
    let runs: Awaited<ReturnType<typeof purgeWorkspace>>[];
    try {
      runs = await Promise.all([run(), run()]);
    } finally {
      await sql`drop trigger hold on attachments`.execute(cloned.db);
    }
    expect(runs.reduce((sum, done) => sum + done.deleted, 0)).toBe(3);
    expect(runs.reduce((sum, done) => sum + done.attachments, 0)).toBe(3);
    const { storage_used_bytes: used } = await cloned.db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', room.workspaceId)
      .executeTakeFirstOrThrow();
    expect(used).toBe('1000');
    expect(storage.keys()).toEqual([]);
  });

  const signedIn = async (room: Room, name: string): Promise<string> => {
    const { token } = await aSession(cloned.db, clock, member(room, name).userId, 30);
    return `${SESSION_COOKIE}=${token}`;
  };

  const request = (method: string, path: string, cookie: string, body: unknown): Request =>
    new Request(`https://purlay.test${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json', origin: 'https://purlay.test' },
      body: JSON.stringify(body),
    });

  const purge = async (room: Room): ReturnType<typeof purgeWorkspace> =>
    await purgeWorkspace(
      { database: cloned.db, clock, log: aRecordingLogger().log, storage: aMemoryStore() },
      { id: room.workspaceId, retentionDays: DAYS },
    );

  const retained = async (room: Room): Promise<void> => {
    await cloned.db
      .updateTable('workspaces')
      .set({ retention_days: DAYS })
      .where('id', '=', room.workspaceId)
      .execute();
  };

  test('a reply to a root the purge takes is the root not found, and the refusal is logged by name', async () => {
    const room = await aRoom(cloned.db, ['ada', 'bob']);
    await retained(room);
    const root = await oldMessage(room);
    const cookie = await signedIn(room, 'bob');
    const { log, lines } = aRecordingLogger();
    const app = createApp(testDependencies({ database: cloned.db, clock, log }));

    await sql`create trigger hold before insert on messages for each row execute function wait_insert()`.execute(
      cloned.db,
    );
    let answer: Response | undefined;
    try {
      await cloned.db.connection().execute(async (holder) => {
        await sql`select pg_advisory_lock(8391)`.execute(holder);
        try {
          const replying = app.handle(
            request('POST', `/api/channels/${room.channelId}/messages`, cookie, {
              id: messageId(NOW),
              content: 'an answer',
              parentId: root,
            }),
          );
          // The positive condition: the reply is at the insert, waiting on the lock — its root read.
          for (let waited = 0; ; waited += 1) {
            const { rows } = await sql<{ n: number }>`
              select count(*)::int as n from pg_stat_activity
              where wait_event_type = 'Lock' and wait_event = 'advisory'
                and datname = current_database()
            `.execute(holder);
            if ((rows[0]?.n ?? 0) > 0) break;
            if (waited > 500) throw new Error('the reply never reached its insert');
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          await purge(room);
          await sql`select pg_advisory_unlock(8391)`.execute(holder);
          answer = await replying;
        } finally {
          await sql`select pg_advisory_unlock_all()`.execute(holder);
        }
      });
    } finally {
      await sql`drop trigger hold on messages`.execute(cloned.db);
    }
    expect(answer?.status).toBe(404);
    expect(((await answer?.json()) as { error: { code: string } }).error.code).toBe(
      'MESSAGE_NOT_FOUND',
    );
    expect(lines.map((line) => [line['msg'], line['constraint']])).toContainEqual([
      'a write referred to a message that is not there',
      'messages_parent_channel_fkey',
    ]);
  });

  test('a reply into a thread the purge is thinning lands, and the purge finishes', async () => {
    const room = await aRoom(cloned.db, ['ada', 'bob']);
    await retained(room);
    const root = await oldMessage(room);
    tick += 1;
    const oldReplyAt = new Date(OLD.getTime() + tick);
    await cloned.db
      .insertInto('messages')
      .values({
        id: messageId(oldReplyAt),
        channel_id: room.channelId,
        workspace_id: room.workspaceId,
        sender_id: member(room, 'bob').userId,
        content: 'old reply',
        parent_id: root,
        created_at: oldReplyAt,
      })
      .execute();
    const cookie = await signedIn(room, 'bob');
    const app = createApp(testDependencies({ database: cloned.db, clock }));
    // The purge holds what it has locked while it deletes the old reply; the send comes in then.
    await sql`create trigger hold before delete on messages for each row execute function hold_delete()`.execute(
      cloned.db,
    );
    let outcome: [Awaited<ReturnType<typeof purgeWorkspace>>, Response];
    try {
      outcome = await Promise.all([
        purge(room),
        app.handle(
          request('POST', `/api/channels/${room.channelId}/messages`, cookie, {
            id: messageId(NOW),
            content: 'a new answer',
            parentId: root,
          }),
        ),
      ]);
    } finally {
      await sql`drop trigger hold on messages`.execute(cloned.db);
    }
    const [purged, answer] = outcome;
    expect(answer.status).toBe(201);
    expect(purged.deleted).toBe(1);
    const thread = await cloned.db
      .selectFrom('messages')
      .select(['thread_reply_count'])
      .where('id', '=', root)
      .executeTakeFirstOrThrow();
    // The root holds the new answer and counts it; whether it was emptied tonight depends on whether
    // the send still held it when the second phase came — busy rows are left for another night.
    expect(thread.thread_reply_count).toBe(1);
  });

  test('a read of a message the purge is taking finishes, and so does the purge', async () => {
    const room = await aRoom(cloned.db, ['ada', 'bob']);
    await retained(room);
    const old = await oldMessage(room);
    const cookie = await signedIn(room, 'bob');
    const app = createApp(testDependencies({ database: cloned.db, clock }));
    await sql`create trigger hold before delete on messages for each row execute function hold_delete()`.execute(
      cloned.db,
    );
    let outcome: [Awaited<ReturnType<typeof purgeWorkspace>>, Response];
    try {
      outcome = await Promise.all([
        purge(room),
        app.handle(
          request('PUT', `/api/channels/${room.channelId}/read`, cookie, {
            lastReadMessageId: old,
          }),
        ),
      ]);
    } finally {
      await sql`drop trigger hold on messages`.execute(cloned.db);
    }
    const [purged, answer] = outcome;
    expect(purged.deleted).toBe(1);
    // Either the read landed first (and its position was then cleared with the message), or the
    // message was gone when it came: an answer, never a deadlock's 500.
    expect([200, 404]).toContain(answer.status);
  });

  test('a workspace whose purge fails says what it did, and the others are purged; the run fails naming it', async () => {
    const poisoned = await aRoom(cloned.db, ['ada', 'bob']);
    const healthy = await aRoom(cloned.db, ['ada', 'bob']);
    await retained(poisoned);
    await retained(healthy);
    const bad = await oldMessage(poisoned);
    await cloned.db
      .updateTable('messages')
      .set({ content: 'poison' })
      .where('id', '=', bad)
      .execute();
    const good = await oldMessage(healthy);
    await sql`
      create function refuse_poison() returns trigger language plpgsql as
      $$ begin if old.content = 'poison' then raise exception 'refused'; end if; return old; end $$
    `.execute(cloned.db);
    await sql`create trigger poison before delete on messages for each row execute function refuse_poison()`.execute(
      cloned.db,
    );
    let failure: unknown = null;
    try {
      await purgeRetention({
        database: cloned.db,
        clock,
        log: aRecordingLogger().log,
        storage: aMemoryStore(),
      }).catch((error: unknown) => {
        failure = error;
      });
    } finally {
      await sql`drop trigger poison on messages`.execute(cloned.db);
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toContain(poisoned.workspaceId);
    expect((failure as AggregateError).message).not.toContain(healthy.workspaceId);
    expect(
      await cloned.db.selectFrom('messages').select('id').where('id', 'in', [bad, good]).execute(),
    ).toEqual([{ id: bad }]);
    const lines = await cloned.db
      .selectFrom('audit_log')
      .select(['workspace_id', 'metadata'])
      .where('workspace_id', 'in', [poisoned.workspaceId, healthy.workspaceId])
      .where('action', '=', 'retention.purged')
      .execute();
    expect(
      lines.find((line) => line.workspace_id === poisoned.workspaceId)?.metadata,
    ).toMatchObject({
      incomplete: 'true',
    });
    expect(
      lines.find((line) => line.workspace_id === healthy.workspaceId)?.metadata,
    ).not.toHaveProperty('incomplete');
  });
});
