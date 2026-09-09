/**
 * The socket, end to end, without a socket.
 *
 * Admission and the router are framework-neutral on purpose, so the security
 * gate and the protocol are driven directly against a real database. What the
 * transport adds — the handshake itself — is thin, and this is what it is thin
 * *around*.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId, type ServerFrame } from '@purlay/types';
import { AppError } from '../platform/errors';
import { fixedClock } from '../platform/clock';
import { issueSession } from '../modules/auth/sessions';
import { createApp } from '../ingress/http/app';
import { testDependencies } from '../ingress/http/testing';
import { channelTopic, inProcessEventBus } from './bus';
import { routeFrame } from './router';
import { admitSocket } from './upgrade';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const ORIGIN = 'https://purlay.test';
const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);

const call = async (
  db: Executor,
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<Response> =>
  await createApp(testDependencies({ database: db, clock })).handle(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );

const signedIn = async (
  db: Executor,
  name: string,
): Promise<{ userId: string; cookie: string }> => {
  const row = await db
    .insertInto('users')
    .values({ email: `${name}@example.test`, username: name, display_name: name })
    .returning('id')
    .executeTakeFirstOrThrow();
  const { token } = await issueSession(db, clock, row.id, 30);
  return { userId: row.id, cookie: `purlay_session=${token}` };
};

const aChannel = async (
  db: Executor,
  who: { cookie: string },
  slug: string,
): Promise<{ workspaceId: string; channelId: string }> => {
  const workspace = await call(db, 'POST', '/api/workspaces', {
    cookie: who.cookie,
    body: { name: slug, slug },
  });
  const workspaceId = ((await workspace.json()) as { id: string }).id;
  const channel = await call(db, 'POST', `/api/workspaces/${workspaceId}/channels`, {
    cookie: who.cookie,
    body: { name: 'general' },
  });
  return { workspaceId, channelId: ((await channel.json()) as { id: string }).id };
};

const upgrade = (cookie?: string, origin: string | null = ORIGIN): Request =>
  new Request(`${ORIGIN}/ws`, {
    headers: {
      ...(origin === null ? {} : { origin }),
      ...(cookie === undefined ? {} : { cookie }),
    },
  });

describe('integration: the socket handshake', () => {
  test('a signed-in caller from the right origin is admitted', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'ws-ok');
      const admitted = await admitSocket(
        { database: db, clock, appUrl: ORIGIN },
        upgrade(alice.cookie),
      );
      expect(admitted.userId).toBe(alice.userId);
    });
  });

  /**
   * `SameSite=Lax` does not reliably protect a handshake: a page on another
   * origin can open the socket and the browser may attach the cookie. This is
   * checked **before the session is looked up** (D-39).
   */
  test('another origin is refused, even with a perfectly valid session', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'ws-evil');
      const refusal = await admitSocket(
        { database: db, clock, appUrl: ORIGIN },
        upgrade(alice.cookie, 'https://attacker.test'),
      ).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(AppError);
      expect((refusal as AppError).body.code).toBe('FORBIDDEN');
    });
  });

  test('a missing origin is refused: a browser following the rules always sends one', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'ws-noorigin');
      const refusal = await admitSocket(
        { database: db, clock, appUrl: ORIGIN },
        upgrade(alice.cookie, null),
      ).catch((error: unknown) => error);
      expect((refusal as AppError).body.code).toBe('FORBIDDEN');
    });
  });

  test('the right origin without a session is refused too', async () => {
    await withRollback(async (db) => {
      const refusal = await admitSocket(
        { database: db, clock, appUrl: ORIGIN },
        upgrade(undefined),
      ).catch((error: unknown) => error);
      expect((refusal as AppError).body.code).toBe('UNAUTHENTICATED');
    });
  });
});

describe('integration: the frame router', () => {
  const route = async (
    db: Executor,
    identity: { userId: string },
    raw: unknown,
    bus = inProcessEventBus(() => undefined),
  ): Promise<readonly ServerFrame[]> =>
    await routeFrame(
      {
        database: db,
        clock,
        bus,
        // Already inside the transaction the harness will roll back, so this is
        // where the boundary is. The shape under test — write, then publish, then
        // acknowledge — is the same one production runs.
        atomically: async (body) => await body(db),
      },
      { socketId: 's1', ...identity },
      raw,
    );

  test('a ping is answered, and the answer names the frame it answers', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'rt-ping');
      const id = messageId(NOW);
      const [reply] = await route(db, alice, { id, op: 'PING', payload: {} });
      expect(reply?.event).toBe('PONG');
      expect(reply?.refId).toBe(id);
    });
  });

  test('bytes that are not a frame are refused without pretending to answer one', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'rt-junk');
      const [reply] = await route(db, alice, 'not json at all');
      expect(reply?.event).toBe('ERROR');
      expect(reply?.refId).toBeUndefined();
    });
  });

  test('a frame that is not in the contract is refused, and echoes its id if it had one', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'rt-shape');
      const id = messageId(NOW);
      const [reply] = await route(db, alice, { id, op: 'THREAD_REPLY', payload: {} });
      expect(reply?.event).toBe('ERROR');
      expect(reply?.refId).toBe(id);
    });
  });

  test('subscribing to a channel you cannot see is refused, not silently ignored', async () => {
    await withRollback(async (db) => {
      const owner = await signedIn(db, 'rt-owner');
      const stranger = await signedIn(db, 'rt-stranger');
      const { channelId } = await aChannel(db, owner, 'rt-closed');

      const [reply] = await route(db, stranger, {
        id: messageId(NOW),
        op: 'SUBSCRIBE',
        payload: { channels: [{ channelId, afterMessageId: null }] },
      });
      expect(reply?.event).toBe('ERROR');
      expect(reply?.data).toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
    });
  });

  /**
   * The publish happens **after the commit returns** (D-35). Publishing from
   * inside the transaction lets a subscriber receive a message that then rolls
   * back — and because the id is durable and client-generated, the receiving
   * client has no way to learn it should forget it.
   */
  test('sending publishes to the channel and acknowledges afterwards', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'rt-send');
      const { channelId } = await aChannel(db, alice, 'rt-send-ws');

      const delivered: ServerFrame[] = [];
      const bus = inProcessEventBus((_socketId, frame) => {
        delivered.push(frame);
      });
      bus.subscribe(channelTopic(channelId), 'listener');

      const id = messageId(NOW);
      const replies = await route(
        db,
        alice,
        { id, op: 'MESSAGE_SEND', payload: { channelId, content: 'hello' } },
        bus,
      );

      expect(replies[0]?.event).toBe('ACK');
      expect(replies[0]?.refId).toBe(id);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.event).toBe('MESSAGE_CREATED');
      expect(delivered[0]?.data).toMatchObject({ id, content: 'hello' });

      // Durable, not only broadcast.
      const rows = await db.selectFrom('messages').selectAll().execute();
      expect(rows).toHaveLength(1);
    });
  });

  test('a refused send publishes nothing, so nobody sees a message that was not written', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'rt-refused');
      const { channelId } = await aChannel(db, alice, 'rt-refused-ws');

      const delivered: ServerFrame[] = [];
      const bus = inProcessEventBus((_socketId, frame) => {
        delivered.push(frame);
      });
      bus.subscribe(channelTopic(channelId), 'listener');

      // A v4 id: refused by the id rule (D-33), so the write never happens.
      const [reply] = await route(
        db,
        alice,
        {
          id: '0199155c-6200-4b7f-8c11-2a4d3f9e1b70',
          op: 'MESSAGE_SEND',
          payload: { channelId, content: 'nope' },
        },
        bus,
      );

      expect(reply?.event).toBe('ERROR');
      expect(reply?.data).toMatchObject({ code: 'INVALID_MESSAGE_ID' });
      expect(delivered).toEqual([]);
      expect(await db.selectFrom('messages').selectAll().execute()).toHaveLength(0);
    });
  });

  test('subscribing replays what was missed, oldest first', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'rt-replay');
      const { channelId } = await aChannel(db, alice, 'rt-replay-ws');

      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const id = messageId(new Date(NOW.getTime() + i));
        ids.push(id);
        await route(db, alice, {
          id,
          op: 'MESSAGE_SEND',
          payload: { channelId, content: `m${String(i)}` },
        });
      }

      const replies = await route(db, alice, {
        id: messageId(NOW),
        op: 'SUBSCRIBE',
        payload: { channels: [{ channelId, afterMessageId: ids[0] ?? null }] },
      });

      expect(replies[0]?.event).toBe('ACK');
      const replayed = replies.slice(1);
      expect(replayed.map((f) => f.event)).toEqual(['MESSAGE_CREATED', 'MESSAGE_CREATED']);
      // Oldest first, so a client appending them ends up in the right order.
      expect(replayed.map((f) => (f.data as { id: string }).id)).toEqual(ids.slice(1));
    });
  });

  test('unsubscribing stops delivery to that connection', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'rt-unsub');
      const { channelId } = await aChannel(db, alice, 'rt-unsub-ws');

      const delivered: ServerFrame[] = [];
      const bus = inProcessEventBus((_socketId, frame) => {
        delivered.push(frame);
      });

      await route(
        db,
        alice,
        {
          id: messageId(NOW),
          op: 'SUBSCRIBE',
          payload: { channels: [{ channelId, afterMessageId: null }] },
        },
        bus,
      );
      await route(
        db,
        alice,
        {
          id: messageId(NOW),
          op: 'UNSUBSCRIBE',
          payload: { channelIds: [channelId] },
        },
        bus,
      );

      await route(
        db,
        alice,
        {
          id: messageId(NOW),
          op: 'MESSAGE_SEND',
          payload: { channelId, content: 'after leaving' },
        },
        bus,
      );

      expect(delivered).toEqual([]);
    });
  });
});
