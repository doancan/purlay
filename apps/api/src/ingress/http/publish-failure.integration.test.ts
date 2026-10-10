/**
 * A publish that fails after the commit is not a failed request (D-35, H-API 4).
 *
 * Every write that tells somebody something — a message, a reaction, a resolution, a read
 * position, a new direct message — commits first and publishes after. The in-process bus cannot
 * throw today; it is the seam the shared adapter replaces (D-7), and the day it is a network
 * call, a write that *succeeded* must not answer 500 and invite a retry of what is already
 * done, nor must the frames behind the one that failed be skipped. Each is logged with what
 * it was publishing, and the rest are still attempted.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { messageId, type ServerFrame } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import {
  publication,
  publishAfterCommit,
  PUBLISH_CHUNK,
  type EventBus,
} from '../../platform/events';
import { atomicallyOn } from '../../platform/transactions';
import { aRecordingLogger, NOW } from '../../testing/doubles';
import { aRoom } from '../../testing/rooms';
import { sendMessage, send } from '../../modules/messages/messages';
import { setResolved } from '../../modules/messages/threads';
import { setReaction } from '../../modules/reactions/reactions';
import { aSignedInUser } from '../../testing/signed-in';
import { openDirectMessageWith, readUpTo } from './channels';
import { aUniqueSlug } from '../../testing/users';
import { createApp } from './app';
import { testDependencies } from '../../testing/doubles';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);

/** A bus whose Nth publish (1-based) throws, and which remembers what did go out. */
const flakyBus = (failOn: readonly number[]): { bus: EventBus; sent: ServerFrame['event'][] } => {
  const sent: ServerFrame['event'][] = [];
  let calls = 0;
  const bus: EventBus = {
    publish: (_topic, frame) => {
      calls += 1;
      if (failOn.includes(calls))
        return Promise.reject(new Error(`the bus is down (${String(calls)})`));
      sent.push(frame.event);
      return Promise.resolve();
    },
    subscribe: () => false,
    unsubscribe: () => undefined,
    forget: () => undefined,
  };
  return { bus, sent };
};

const mark = (into: string[], what: string): Promise<void> => {
  into.push(what);
  return Promise.resolve();
};

const idAt = (offset: number): string => messageId(new Date(NOW.getTime() + offset));

describe('integration: publishAfterCommit', () => {
  test('stages go in order, a failure is logged and the rest still go, and it never throws', async () => {
    const { log, lines } = aRecordingLogger();
    const order: string[] = [];
    await publishAfterCommit(log, [
      [publication('first', () => mark(order, 'first'))],
      [
        publication('second-a', () => Promise.reject(new Error('boom'))),
        publication('second-b', () => mark(order, 'second-b')),
      ],
      [publication('third', () => mark(order, 'third'))],
    ]);
    expect(order).toEqual(['first', 'second-b', 'third']);
    expect(lines.map((line) => [line['msg'], line['what']])).toEqual([
      ['publish failed after commit', 'second-a'],
    ]);
  });

  test('a stage larger than a chunk is sent in chunks, every one of them', async () => {
    const { log } = aRecordingLogger();
    let inFlight = 0;
    let widest = 0;
    let done = 0;
    const total = PUBLISH_CHUNK * 2 + 5;
    await publishAfterCommit(log, [
      Array.from({ length: total }, (_, n) => ({
        label: `p${String(n)}`,
        run: async (): Promise<void> => {
          inFlight += 1;
          widest = Math.max(widest, inFlight);
          await Promise.resolve();
          inFlight -= 1;
          done += 1;
        },
      })),
    ]);
    expect(done).toBe(total);
    expect(widest).toBeLessThanOrEqual(PUBLISH_CHUNK);
    expect(widest).toBeGreaterThan(1);
  });

  test('an empty list of stages, or an empty stage, is nothing to do', async () => {
    const { log, lines } = aRecordingLogger();
    await publishAfterCommit(log, []);
    await publishAfterCommit(log, [[]]);
    expect(lines).toEqual([]);
  });
});

describe('integration: the write stands when its announcement fails', () => {
  test('a send: answered, the failure logged, the later frames still attempted', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      const alice = room.members['alice'];
      if (alice === undefined) throw new Error('room');
      // MESSAGE_CREATED fails; the two CHANNEL_STATE frames behind it must still go.
      const { bus, sent } = flakyBus([1]);
      const { log, lines } = aRecordingLogger();
      const id = idAt(0);
      const answer = await send({ atomically: atomicallyOn(db), clock, bus, log }, alice.context, {
        id,
        content: 'hello',
      });
      expect(answer.id).toBe(id);
      expect(sent).toEqual(['CHANNEL_STATE', 'CHANNEL_STATE']);
      expect(lines.map((line) => line['what'])).toEqual(['MESSAGE_CREATED']);
    });
  });

  test('a reaction and a resolution: answered, logged', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const alice = room.members['alice'];
      const bob = room.members['bob'];
      if (alice === undefined || bob === undefined) throw new Error('room');
      const root = await sendMessage(db, clock, alice.context, { id: idAt(0), content: 'q' });
      await sendMessage(db, clock, bob.context, {
        id: idAt(1),
        content: 'a',
        parentId: root.message.id,
      });
      const { bus } = flakyBus([1, 2]);
      const { log, lines } = aRecordingLogger();
      const dependencies = { atomically: atomicallyOn(db), clock, bus, log };

      const session = await db
        .insertInto('sessions')
        .values({
          user_id: bob.userId,
          token_hash: `h-${crypto.randomUUID()}`,
          expires_at: new Date(NOW.getTime() + 86_400_000),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const reacted = await setReaction(
        dependencies,
        { userId: bob.userId, sessionId: session.id },
        root.message.id,
        '👍',
        true,
      );
      expect(reacted.reactions).toEqual([{ emoji: '👍', userIds: [bob.userId] }]);

      const resolved = await setResolved(dependencies, bob.userId, root.message.id, true);
      expect(resolved.thread?.resolvedBy?.id).toBe(bob.userId);
      expect(lines.map((line) => line['what'])).toEqual(['REACTIONS_UPDATED', 'THREAD_UPDATED']);
    });
  });
});

describe('integration: a read and a direct message announce through the same door', () => {
  test('a read position answers and logs when its frame cannot be sent; a repeated one tells again', async () => {
    await withRollback(async (db) => {
      const alice = await aSignedInUser(db, clock, 'pf-alice');
      const bob = await aSignedInUser(db, clock, 'pf-bob');
      const app = createApp(testDependencies({ database: db, clock }));
      const post = async (path: string, body: unknown, cookie: string): Promise<Response> =>
        await app.handle(
          new Request(`https://purlay.test${path}`, {
            method: 'POST',
            headers: { cookie, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
        );
      const workspace = (await (
        await post('/api/workspaces', { name: 'pf', slug: aUniqueSlug('pf') }, alice.cookie)
      ).json()) as { id: string };
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: workspace.id, user_id: bob.userId, role: 'member', joined_at: NOW })
        .execute();
      const channel = (await (
        await post(`/api/workspaces/${workspace.id}/channels`, { name: 'general' }, alice.cookie)
      ).json()) as { id: string };
      await post(`/api/channels/${channel.id}/join`, {}, bob.cookie);
      const first = idAt(0);
      const said = await post(
        `/api/channels/${channel.id}/messages`,
        { id: first, content: 'hi' },
        bob.cookie,
      );
      expect(said.status).toBe(201);

      // Called directly with a bus that throws, as the shared adapter one day might.
      const { bus, sent } = flakyBus([1]);
      const { log, lines } = aRecordingLogger();
      const dependencies = { database: db, clock, bus, log };
      const read = await readUpTo(
        dependencies,
        new Request('https://purlay.test/', { headers: { cookie: alice.cookie } }),
        channel.id,
        { lastReadMessageId: first },
      );
      expect(read).toMatchObject({ lastReadMessageId: first, unreadCount: 0 });
      expect(lines.map((line) => line['what'])).toEqual(['CHANNEL_STATE']);

      // A repeat does not move, and still tells the caller's devices where they stand.
      await readUpTo(
        dependencies,
        new Request('https://purlay.test/', { headers: { cookie: alice.cookie } }),
        channel.id,
        { lastReadMessageId: first },
      );
      expect(sent).toEqual(['CHANNEL_STATE']);

      // A direct message: created, answered, the peer's frame failed and logged.
      const failing = flakyBus([1]);
      const second = aRecordingLogger();
      const opened = await openDirectMessageWith(
        { database: db, clock, bus: failing.bus, log: second.log },
        new Request('https://purlay.test/', { headers: { cookie: alice.cookie } }),
        workspace.id,
        { userId: bob.userId },
      );
      expect(opened.created).toBe(true);
      expect(second.lines.map((line) => line['what'])).toEqual(['CHANNEL_ADDED']);
    });
  });
});
