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
import {
  MESSAGE_CONTENT_MAX,
  messageId,
  SUBSCRIBE_MAX_CHANNELS,
  type ServerFrame,
} from '@purlay/types';
import { AppError } from '../platform/errors';
import { fixedClock } from '../platform/clock';
import { createApp } from '../ingress/http/app';
import { testDependencies } from '../ingress/http/testing';
import { inProcessEventBus } from './bus';
import { channelTopic } from '../platform/events';
import { atomicallyOn } from '../platform/transactions';
import { createLogger } from '../platform/logging';
import { REPLAY_BYTES_MAX, replayPerChannel, routeFrame } from './router';
import { admitSocket } from './upgrade';
import { inProcessRateLimiter, SOCKET_FRAME_BUDGET, type RateLimiter } from './rate-limiter';
import { aSignedInUser, type SignedInUser } from '../ingress/http/fixtures';
import { aUniqueSlug } from '../testing/users';

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

const signedIn = async (db: Executor, name: string): Promise<SignedInUser> =>
  await aSignedInUser(db, clock, name);

const aChannel = async (
  db: Executor,
  who: { cookie: string },
  slug: string,
): Promise<{ workspaceId: string; channelId: string }> => {
  const workspace = await call(db, 'POST', '/api/workspaces', {
    cookie: who.cookie,
    body: { name: slug, slug: aUniqueSlug(slug) },
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
    bus = inProcessEventBus(() => undefined, createLogger({ level: 'silent' })),
    // A fresh bucket per call, so no test here is limited unless it means to be.
    limiter: RateLimiter = inProcessRateLimiter(clock, SOCKET_FRAME_BUDGET),
  ): Promise<readonly ServerFrame[]> =>
    await routeFrame(
      {
        database: db,
        clock,
        bus,
        limiter,
        log: createLogger({ level: 'silent' }),
        socket: { hold: () => undefined, isOpen: () => true, drop: () => undefined },
        // The production boundary: inside the harness's transaction it joins it.
        atomically: atomicallyOn(db),
      },
      { socketId: 's1', sessionId: 'not-read-by-the-router', expiresAt: NOW, ...identity },
      raw,
    );

  test('a frame over budget is refused before it is read, and does nothing', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'rt-limited');
      const { channelId } = await aChannel(db, alice, 'rt-limited-ws');
      const spent: RateLimiter = {
        consume: async () => await Promise.resolve(false),
        forget: () => undefined,
      };

      const id = messageId(NOW);
      const replies = await route(
        db,
        alice,
        { id, op: 'MESSAGE_SEND', payload: { channelId, content: 'over budget' } },
        undefined,
        spent,
      );
      expect(replies).toMatchObject([
        { event: 'ERROR', refId: id, data: { code: 'RATE_LIMITED' } },
      ]);
      expect(
        await db.selectFrom('messages').select('id').where('channel_id', '=', channelId).execute(),
      ).toEqual([]);

      // Bytes that are not a frame spend the budget too, and get no refId to echo.
      const garbage = await route(db, alice, 'not a frame', undefined, spent);
      expect(garbage).toHaveLength(1);
      expect(garbage[0]).toMatchObject({ event: 'ERROR', data: { code: 'RATE_LIMITED' } });
      expect(garbage[0]?.refId).toBeUndefined();
    });
  });

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
      const bus = inProcessEventBus(
        (_socketId, frame) => {
          delivered.push(frame);
        },
        createLogger({ level: 'silent' }),
      );
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

      // Durable, not only broadcast — and scoped to this channel, because the
      // harness rolls back this test's writes rather than emptying the database.
      const rows = await db
        .selectFrom('messages')
        .select('id')
        .where('channel_id', '=', channelId)
        .execute();
      expect(rows).toHaveLength(1);
    });
  });

  test('a refused send publishes nothing, so nobody sees a message that was not written', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'rt-refused');
      const { channelId } = await aChannel(db, alice, 'rt-refused-ws');

      const delivered: ServerFrame[] = [];
      const bus = inProcessEventBus(
        (_socketId, frame) => {
          delivered.push(frame);
        },
        createLogger({ level: 'silent' }),
      );
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
      expect(
        await db.selectFrom('messages').select('id').where('channel_id', '=', channelId).execute(),
      ).toHaveLength(0);
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

      expect(replies[0]).toMatchObject({
        event: 'ACK',
        data: { channels: [{ channelId, nextCursor: null }] },
      });
      const replayed = replies.slice(1);
      expect(replayed.every((f) => f.event === 'MESSAGE_CREATED')).toBe(true);
      // Oldest first, so a client appending them ends up in the right order. The
      // replay starts below the cursor (D-65), so the one the client named comes
      // back too — and nothing it did not miss besides.
      expect(replayed.map((f) => (f.data as { id: string }).id)).toEqual(ids);
    });
  });

  test('unsubscribing stops delivery to that connection', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'rt-unsub');
      const { channelId } = await aChannel(db, alice, 'rt-unsub-ws');

      const delivered: ServerFrame[] = [];
      const bus = inProcessEventBus(
        (_socketId, frame) => {
          delivered.push(frame);
        },
        createLogger({ level: 'silent' }),
      );
      const sendOne = async (content: string, at: number): Promise<readonly ServerFrame[]> =>
        await route(
          db,
          alice,
          {
            id: messageId(new Date(NOW.getTime() + at)),
            op: 'MESSAGE_SEND',
            payload: { channelId, content },
          },
          bus,
        );

      const subscribed = await route(
        db,
        alice,
        {
          id: messageId(NOW),
          op: 'SUBSCRIBE',
          payload: { channels: [{ channelId, afterMessageId: null }] },
        },
        bus,
      );
      expect(subscribed[0]?.event).toBe('ACK');

      // The control: subscribed, a send is delivered. Without it, the empty list
      // below would pass just as well if subscribing or sending did nothing.
      expect((await sendOne('while listening', 1))[0]?.event).toBe('ACK');
      expect(delivered.map((f) => f.event)).toEqual(['MESSAGE_CREATED']);

      const left = await route(
        db,
        alice,
        { id: messageId(NOW), op: 'UNSUBSCRIBE', payload: { channelIds: [channelId] } },
        bus,
      );
      expect(left[0]).toMatchObject({ event: 'ACK', data: { channelIds: [channelId] } });

      expect((await sendOne('after leaving', 2))[0]?.event).toBe('ACK');
      expect(delivered.map((f) => f.event)).toEqual(['MESSAGE_CREATED']);
    });
  });

  /**
   * One subscription, bounded work, whatever it names (#196). Before, each channel
   * cost its own authorisation and its own replay query; a frame naming hundreds
   * was thousands of queries for one rate-limit token.
   */
  describe('a subscription naming many channels', () => {
    /** Public channels in one workspace Alice owns, each with `missed` messages. */
    const manyChannels = async (
      db: Executor,
      alice: { userId: string; cookie: string },
      count: number,
      missed: number,
      content: (i: number) => string = (i) => `m${String(i)}`,
    ): Promise<string[]> => {
      const { workspaceId } = await aChannel(
        db,
        alice,
        `rt-many-${String(count)}-${String(missed)}`,
      );
      const channels = await db
        .insertInto('channels')
        .values(
          Array.from({ length: count }, (_, i) => ({
            workspace_id: workspaceId,
            name: `c${String(i)}`,
            type: 'public' as const,
            created_by: alice.userId,
          })),
        )
        .returning('id')
        .execute();
      const messages = channels.flatMap(({ id }) =>
        Array.from({ length: missed }, (_, i) => ({
          id: messageId(new Date(NOW.getTime() + i)),
          workspace_id: workspaceId,
          channel_id: id,
          sender_id: alice.userId,
          content: content(i),
          created_at: NOW,
        })),
      );
      if (messages.length > 0) await db.insertInto('messages').values(messages).execute();
      return channels.map(({ id }) => id);
    };

    const subscribeTo = (
      channelIds: readonly string[],
      afterMessageId: string | null,
    ): unknown => ({
      id: messageId(NOW),
      op: 'SUBSCRIBE',
      payload: { channels: channelIds.map((channelId) => ({ channelId, afterMessageId })) },
    });

    test('costs the same number of queries for one channel as for thirty', async () => {
      await withRollback(async (db) => {
        const alice = await signedIn(db, 'rt-cost');
        const channels = await manyChannels(db, alice, 30, 3);
        const cursor = messageId(new Date(NOW.getTime() - 1));

        const queriesFor = async (channelIds: readonly string[]): Promise<number> => {
          let queries = 0;
          const counted = db.withPlugin({
            transformQuery: (args) => {
              queries += 1;
              return args.node;
            },
            transformResult: async (args) => await Promise.resolve(args.result),
          });
          const replies = await route(counted, alice, subscribeTo(channelIds, cursor));
          expect(replies[0]?.event).toBe('ACK');
          return queries;
        };

        const one = await queriesFor(channels.slice(0, 1));
        const thirty = await queriesFor(channels);
        expect(one).toBeGreaterThan(0);
        expect(thirty).toBe(one);
      });
    });

    test('shares one replay budget, and says where each channel stopped', async () => {
      await withRollback(async (db) => {
        const alice = await signedIn(db, 'rt-budget');
        const channels = await manyChannels(db, alice, 20, 60);
        const replies = await route(
          db,
          alice,
          subscribeTo(channels, messageId(new Date(NOW.getTime() - 120_000))),
        );

        const ack = replies[0];
        if (ack?.event !== 'ACK' || !('channels' in ack.data))
          throw new Error('no subscription ACK');
        const perChannel = replayPerChannel(20);
        expect(perChannel).toBe(50);
        expect(ack.data.channels).toHaveLength(20);
        expect(ack.data.channels.every((state) => state.nextCursor !== null)).toBe(true);
        expect(replies.slice(1)).toHaveLength(20 * perChannel);
      });
    });

    /**
     * The byte budget can stop a replay mid-channel, or before a channel starts.
     * Either way the cursor it returns must lose nothing: continuing every channel
     * over HTTP from its cursor yields exactly what was missed (#197).
     */
    test('a replay cut by its byte budget loses nothing when continued', async () => {
      await withRollback(async (db) => {
        const alice = await signedIn(db, 'rt-bytes');
        const channels = await manyChannels(db, alice, 3, 30, (i) =>
          String(i).padEnd(MESSAGE_CONTENT_MAX, 'z'),
        );
        const replies = await route(
          db,
          alice,
          subscribeTo(channels, messageId(new Date(NOW.getTime() - 120_000))),
        );
        const ack = replies[0];
        if (ack?.event !== 'ACK' || !('channels' in ack.data))
          throw new Error('no subscription ACK');
        const replayed = replies.slice(1);
        const bytes = replayed.reduce(
          (sum, f) => sum + Buffer.byteLength(JSON.stringify(f), 'utf8'),
          0,
        );
        expect(bytes).toBeLessThanOrEqual(REPLAY_BYTES_MAX);
        expect(replayed.length).toBeLessThan(90);

        const recovered = new Map<string, string[]>(channels.map((id) => [id, []]));
        for (const f of replayed) {
          const message = f.data as { id: string; channelId: string };
          recovered.get(message.channelId)?.push(message.id);
        }
        for (const state of ack.data.channels) {
          let cursor = state.nextCursor;
          while (cursor !== null) {
            const response = await call(
              db,
              'GET',
              `/api/channels/${state.channelId}/messages?after=${cursor}&limit=100`,
              { cookie: alice.cookie },
            );
            const page = (await response.json()) as {
              data: { id: string }[];
              nextCursor: string | null;
            };
            recovered.get(state.channelId)?.push(...page.data.map((m) => m.id));
            cursor = page.nextCursor;
          }
        }
        for (const channelId of channels) {
          const all = await db
            .selectFrom('messages')
            .select('id')
            .where('channel_id', '=', channelId)
            .orderBy('id')
            .execute();
          expect(recovered.get(channelId)).toEqual(all.map((row) => row.id));
        }
      });
    });

    test('one channel the caller cannot see refuses the frame, and nothing is subscribed', async () => {
      await withRollback(async (db) => {
        const alice = await signedIn(db, 'rt-all-or-none');
        const bob = await signedIn(db, 'rt-all-or-none-other');
        const [visible = ''] = await manyChannels(db, alice, 1, 0);
        const { channelId: hidden } = await aChannel(db, bob, 'rt-all-or-none-bob');

        const delivered: ServerFrame[] = [];
        const bus = inProcessEventBus(
          (_socketId, frame) => {
            delivered.push(frame);
          },
          createLogger({ level: 'silent' }),
        );
        const replies = await route(db, alice, subscribeTo([visible, hidden], null), bus);
        expect(replies).toMatchObject([{ event: 'ERROR', data: { code: 'CHANNEL_NOT_FOUND' } }]);

        await bus.publish(channelTopic(visible), {
          event: 'PONG',
          data: {},
          ts: NOW.getTime(),
        });
        expect(delivered).toEqual([]);
      });
    });

    test('a replay cursor that is not a v7 id is refused, naming the field', async () => {
      await withRollback(async (db) => {
        const alice = await signedIn(db, 'rt-v4-cursor');
        const channels = await manyChannels(db, alice, 1, 0);
        const replies = await route(
          db,
          alice,
          subscribeTo(channels, '0b1a8c9e-4f5d-4c3b-9a2e-1d0f3e4c5b6a'),
        );
        expect(replies).toMatchObject([
          {
            event: 'ERROR',
            data: {
              code: 'VALIDATION_FAILED',
              details: { fields: { afterMessageId: 'is not a message id' } },
            },
          },
        ]);
      });
    });

    test('a channel named twice, or more than the limit, is refused with the field', async () => {
      await withRollback(async (db) => {
        const alice = await signedIn(db, 'rt-limits');
        const channels = await manyChannels(db, alice, 1, 0);
        const twice = await route(db, alice, subscribeTo([...channels, ...channels], null));
        expect(twice).toMatchObject([
          {
            event: 'ERROR',
            data: {
              code: 'VALIDATION_FAILED',
              details: { fields: { 'payload/channels': 'names a channel more than once' } },
            },
          },
        ]);

        const tooMany = Array.from(
          { length: SUBSCRIBE_MAX_CHANNELS + 1 },
          (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        );
        const over = await route(db, alice, subscribeTo(tooMany, null));
        expect(over[0]).toMatchObject({ event: 'ERROR', data: { code: 'VALIDATION_FAILED' } });
      });
    });
  });
});
