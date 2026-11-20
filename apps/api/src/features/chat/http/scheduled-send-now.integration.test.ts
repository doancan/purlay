/**
 * Send now (D-324): `POST /api/channels/:channelId/scheduled/:scheduledId/send` delivers the caller's own scheduled
 * message at once, through the scheduler's path, and never twice — not on a double press, and not against the
 * scheduler's own tick. Through the real application and a real database, because the guarantee is a row lock.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  sql,
  closeIntegrationDatabase,
  type ClonedDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import { messageId, type Message, type ServerFrame } from '@purlay/types';
import { fixedClock } from '../../../platform/clock';
import { SESSION_COOKIE } from '../../../platform/cookies';
import { NO_LOG, type EventBus } from '../../../platform/events';
import { inProcessBackplane, type Backplane } from '../../../realtime/bus';
import { createApp, type HttpApplication } from '../../../ingress/http/app';
import { testDependencies } from '../../../testing/doubles';
import { aRoom, type Room } from '../../../testing/rooms';
import { aSession } from '../../../testing/signed-in';
import { deliverScheduled } from '../scheduled/delivery';

const now = new Date('2026-11-20T12:00:00.000Z');
const clock = fixedClock(now);
/** The scheduler's clock: a minute on, when every message these tests schedule is due. */
const due = fixedClock(new Date(now.getTime() + 60_000));
const sendAt = due.now().toISOString();

let cloned: ClonedDatabase;
let app: HttpApplication;
const events: ServerFrame[] = [];
/** The scheduler's own bus, and the application's: both record what they tell. */
const bus: EventBus = {
  publish: (_topic, frame) => {
    events.push(frame);
    return Promise.resolve();
  },
  subscribe: () => false,
  unsubscribe: () => undefined,
  forget: () => undefined,
};
const shared = inProcessBackplane();
const backplane: Backplane = {
  ...shared,
  node: (deliver, log) => {
    const node = shared.node(deliver, log);
    return {
      ...node,
      publish: async (topic, frame): Promise<void> => {
        events.push(frame);
        await node.publish(topic, frame);
      },
    };
  },
};

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  app = createApp(testDependencies({ database: cloned.db, clock, backplane }));
}, CLONE_HOOK_MS);
afterEach(async () => {
  // The scheduler reads every due row of the database: each test starts with none left by another.
  await cloned.db.deleteFrom('scheduled_messages').execute();
  events.length = 0;
});
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

interface Person {
  readonly userId: string;
  readonly token: string;
}

const call = async (
  method: string,
  path: string,
  who: Person | undefined,
  body?: unknown,
): Promise<Response> =>
  await app.handle(
    new Request(`https://purlay.test${path}`, {
      method,
      headers: {
        ...(who === undefined ? {} : { cookie: `${SESSION_COOKIE}=${who.token}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const personIn = async (room: Room, name: string): Promise<Person> => {
  const userId = room.members[name]?.userId ?? room.outsiders[name]?.userId;
  if (userId === undefined) throw new Error(`no ${name} in the room`);
  return { userId, token: (await aSession(cloned.db, clock, userId, 30)).token };
};

const schedule = async (
  room: Room,
  who: Person,
  input: { readonly content: string; readonly parentId?: string } = { content: 'Ship it' },
): Promise<string> => {
  const id = messageId(now);
  const response = await call('PUT', `/api/channels/${room.channelId}/scheduled/${id}`, who, {
    ...input,
    sendAt,
  });
  expect(response.status).toBe(200);
  return id;
};

const sendNow = async (room: Room, id: string, who: Person | undefined): Promise<Response> =>
  await call('POST', `/api/channels/${room.channelId}/scheduled/${id}/send`, who);

const codeOf = async (response: Response): Promise<[number, unknown]> => [
  response.status,
  ((await response.json()) as { error?: { code?: string } }).error?.code,
];

const messagesIn = async (
  room: Room,
): Promise<readonly { id: string; content: string; parent_id: string | null }[]> =>
  await cloned.db
    .selectFrom('messages')
    .select(['id', 'content', 'parent_id'])
    .where('channel_id', '=', room.channelId)
    .where('deleted_at', 'is', null)
    .orderBy('id')
    .execute();

const rowOf = async (
  id: string,
): Promise<{ state: string; sent_message_id: string | null; failure_code: string | null }> =>
  await cloned.db
    .selectFrom('scheduled_messages')
    .select(['state', 'sent_message_id', 'failure_code'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();

/** How many of this database's connections are waiting for a row lock. */
const waitingOnLocks = async (): Promise<number> =>
  (
    await sql<{ count: number }>`
      select count(*)::int as count from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`.execute(cloned.db)
  ).rows[0]?.count ?? 0;

describe('integration: Send now', () => {
  test('sends the message at once under a new UUIDv7, marks the row sent and tells the room', async () => {
    const room = await aRoom(cloned.db, ['alice', 'bob']);
    const alice = await personIn(room, 'alice');
    const id = await schedule(room, alice, { content: 'Çarşamba görüşelim 👋' });

    const response = await sendNow(room, id, alice);
    expect(response.status).toBe(200);
    const message = (await response.json()) as Message;
    expect(message.content).toBe('Çarşamba görüşelim 👋');
    expect(message.id).not.toBe(id);
    // Minted at delivery, now, not at the time it was scheduled for.
    expect(message.createdAt).toBe(now.toISOString());

    expect(await messagesIn(room)).toEqual([
      { id: message.id, content: 'Çarşamba görüşelim 👋', parent_id: null },
    ]);
    expect(await rowOf(id)).toEqual({
      state: 'sent',
      sent_message_id: message.id,
      failure_code: null,
    });
    expect(
      events.filter((event) => event.event === 'MESSAGE_CREATED').map((event) => event.data),
    ).toEqual([message]);

    // It has left the list, and the scheduler has nothing more to send.
    const list = await call('GET', `/api/workspaces/${room.workspaceId}/scheduled`, alice);
    expect(await list.json()).toEqual([]);
    expect(await deliverScheduled({ database: cloned.db, clock: due, bus, log: NO_LOG })).toBe(0);
    expect(await messagesIn(room)).toHaveLength(1);
  });

  test('a second press is 409 SCHEDULED_MESSAGE_SENT and sends nothing more', async () => {
    const room = await aRoom(cloned.db, ['alice']);
    const alice = await personIn(room, 'alice');
    const id = await schedule(room, alice);

    const [first, second] = await Promise.all([sendNow(room, id, alice), sendNow(room, id, alice)]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const again = await sendNow(room, id, alice);
    expect(await codeOf(again)).toEqual([409, 'SCHEDULED_MESSAGE_SENT']);
    expect(await messagesIn(room)).toHaveLength(1);
    // Nor can it be cancelled or edited once it went.
    expect(
      await codeOf(await call('DELETE', `/api/channels/${room.channelId}/scheduled/${id}`, alice)),
    ).toEqual([409, 'SCHEDULED_MESSAGE_SENT']);
  });

  test('a scheduler tick that sent it first leaves Send now 409, and one message', async () => {
    const room = await aRoom(cloned.db, ['alice']);
    const alice = await personIn(room, 'alice');
    const id = await schedule(room, alice);
    expect(await deliverScheduled({ database: cloned.db, clock: due, bus, log: NO_LOG })).toBe(1);
    expect(await codeOf(await sendNow(room, id, alice))).toEqual([409, 'SCHEDULED_MESSAGE_SENT']);
    expect(await messagesIn(room)).toHaveLength(1);
  });

  test('Send now waits for a delivery holding the row, then answers 409 instead of sending again', async () => {
    const room = await aRoom(cloned.db, ['alice']);
    const alice = await personIn(room, 'alice');
    const id = await schedule(room, alice);
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = (): void => undefined;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // Another node's delivery: it holds the row's lock, and commits it as sent.
    const delivery = cloned.db.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom('scheduled_messages')
        .select('id')
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      locked();
      await held;
      await transaction
        .updateTable('scheduled_messages')
        .set({ state: 'sent' })
        .where('id', '=', id)
        .execute();
    });
    await isLocked;
    const press = { answered: false };
    const pressed = sendNow(room, id, alice).finally(() => {
      press.answered = true;
    });
    // The positive condition: the press is a backend waiting on that lock, not a request not yet begun.
    for (let attempt = 0; (await waitingOnLocks()) === 0; attempt += 1) {
      if (attempt > 400 || press.answered) throw new Error('Send now never waited for the lock');
      await Bun.sleep(5);
    }
    expect(press.answered).toBe(false);
    release();
    await delivery;
    expect(await codeOf(await pressed)).toEqual([409, 'SCHEDULED_MESSAGE_SENT']);
    expect(await messagesIn(room)).toHaveLength(0);
  });

  test('a scheduler tick while Send now holds the row skips it rather than sending it twice', async () => {
    const rooms = await Promise.all(
      Array.from({ length: 8 }, async () => await aRoom(cloned.db, ['alice'])),
    );
    const scheduled = await Promise.all(
      rooms.map(async (room) => {
        const alice = await personIn(room, 'alice');
        return { room, alice, id: await schedule(room, alice) };
      }),
    );
    const [ticks, ...presses] = await Promise.all([
      deliverScheduled({ database: cloned.db, clock: due, bus, log: NO_LOG }),
      ...scheduled.map(async ({ room, id, alice }) => (await sendNow(room, id, alice)).status),
    ]);
    expect(presses.every((status) => status === 200 || status === 409)).toBe(true);
    expect(presses.filter((status) => status === 200)).toHaveLength(8 - ticks);
    for (const { room, id } of scheduled) {
      const messages = await messagesIn(room);
      expect(messages).toHaveLength(1);
      expect((await rowOf(id)).sent_message_id).toBe(messages[0]?.id ?? '');
    }
  });

  test('somebody else’s, another workspace’s, another channel’s or a malformed id is 404; signed out is 401', async () => {
    const room = await aRoom(cloned.db, ['alice', 'bob']);
    const elsewhere = await aRoom(cloned.db, ['mallory']);
    const alice = await personIn(room, 'alice');
    const bob = await personIn(room, 'bob');
    const mallory = await personIn(elsewhere, 'mallory');
    const id = await schedule(room, alice);

    expect(await codeOf(await sendNow(room, id, bob))).toEqual([
      404,
      'SCHEDULED_MESSAGE_NOT_FOUND',
    ]);
    expect(await codeOf(await sendNow(room, id, mallory))).toEqual([404, 'CHANNEL_NOT_FOUND']);
    expect(
      await codeOf(
        await call('POST', `/api/channels/${elsewhere.channelId}/scheduled/${id}/send`, mallory),
      ),
    ).toEqual([404, 'SCHEDULED_MESSAGE_NOT_FOUND']);
    expect(await codeOf(await sendNow(room, 'not-an-id', alice))).toEqual([
      404,
      'SCHEDULED_MESSAGE_NOT_FOUND',
    ]);
    expect(await codeOf(await sendNow(room, messageId(now), alice))).toEqual([
      404,
      'SCHEDULED_MESSAGE_NOT_FOUND',
    ]);
    expect((await sendNow(room, id, undefined)).status).toBe(401);

    // None of them touched it: it is still waiting, and nothing was sent.
    expect(await rowOf(id)).toEqual({
      state: 'pending',
      sent_message_id: null,
      failure_code: null,
    });
    expect(await messagesIn(room)).toEqual([]);
  });

  test('a removed member is refused as the scheduler refuses them, the row says why, and rejoining sends it', async () => {
    const room = await aRoom(cloned.db, ['alice', 'bob']);
    const alice = await personIn(room, 'alice');
    const id = await schedule(room, alice);
    await cloned.db
      .deleteFrom('channel_members')
      .where('channel_id', '=', room.channelId)
      .where('user_id', '=', alice.userId)
      .execute();

    expect(await codeOf(await sendNow(room, id, alice))).toEqual([403, 'NOT_A_CHANNEL_MEMBER']);
    expect(await rowOf(id)).toEqual({
      state: 'failed',
      sent_message_id: null,
      failure_code: 'NOT_A_CHANNEL_MEMBER',
    });
    expect(await messagesIn(room)).toEqual([]);

    // A failed message can be sent now once what stopped it is fixed.
    await cloned.db
      .insertInto('channel_members')
      .values({ channel_id: room.channelId, user_id: alice.userId })
      .execute();
    const retried = await sendNow(room, id, alice);
    expect(retried.status).toBe(200);
    expect(await rowOf(id)).toMatchObject({ state: 'sent' });
  });

  test('a reply whose root was deleted is refused with MESSAGE_NOT_FOUND and sends nothing', async () => {
    const room = await aRoom(cloned.db, ['alice']);
    const alice = await personIn(room, 'alice');
    const root = await call('POST', `/api/channels/${room.channelId}/messages`, alice, {
      id: messageId(now),
      content: 'Root',
    });
    const rootId = ((await root.json()) as Message).id;
    const id = await schedule(room, alice, { content: 'Reply later', parentId: rootId });
    expect((await call('DELETE', `/api/messages/${rootId}`, alice)).status).toBe(204);

    expect(await codeOf(await sendNow(room, id, alice))).toEqual([404, 'MESSAGE_NOT_FOUND']);
    expect(await rowOf(id)).toMatchObject({ state: 'failed', failure_code: 'MESSAGE_NOT_FOUND' });
    expect(await messagesIn(room)).toEqual([]);
  });

  test('a reply goes to its thread', async () => {
    const room = await aRoom(cloned.db, ['alice']);
    const alice = await personIn(room, 'alice');
    const root = await call('POST', `/api/channels/${room.channelId}/messages`, alice, {
      id: messageId(now),
      content: 'Root',
    });
    const rootId = ((await root.json()) as Message).id;
    const id = await schedule(room, alice, { content: 'In the thread', parentId: rootId });
    const sent = (await (await sendNow(room, id, alice)).json()) as Message;
    expect(sent.parentId).toBe(rootId);
    expect(events.some((event) => event.event === 'THREAD_UPDATED')).toBe(true);
  });
});
