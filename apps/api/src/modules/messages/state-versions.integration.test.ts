/**
 * The order a whole state was written in (`0015_state_versions`, D-99 §2 amended).
 *
 * `CHANNEL_STATE`, `THREAD_UPDATED` and `REACTIONS_UPDATED` each say "this is the state, replace
 * what you hold". Published after the commit and from different requests, two of them can
 * arrive in the opposite order to the one their writes committed in, and the older would
 * overwrite the newer. Each carries the count of changes its row has had, taken in the
 * statement that made the change, so the client can tell. These tests pin that the count goes
 * up with every change, never with a repeat that changed nothing, and that what is published
 * is the count the state was read at.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId, type ServerFrame } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import type { EventBus } from '../../platform/events';
import { atomicallyOn } from '../../platform/transactions';
import { markRead } from '../channels/read-state';
import { setReaction } from '../reactions/reactions';
import { aRoom, type Room } from '../../testing/rooms';
import { send, sendMessage } from './messages';
import { setResolved } from './threads';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
let tick = 0;
const nextId = (): string => messageId(new Date(NOW.getTime() + (tick += 1) * 10));

const versionsOf = (frames: readonly ServerFrame[], event: ServerFrame['event']): number[] =>
  frames.flatMap((frame) => (frame.event === event && 'version' in frame ? [frame.version] : []));

const recording = (): { bus: EventBus; frames: ServerFrame[] } => {
  const frames: ServerFrame[] = [];
  const bus: EventBus = {
    publish: (_topic, frame) => {
      frames.push(frame);
      return Promise.resolve();
    },
    subscribe: () => false,
    unsubscribe: () => undefined,
    forget: () => undefined,
  };
  return { bus, frames };
};

const stored = async (
  db: Executor,
  room: Room,
  name: string,
): Promise<{ readonly version: number }> => {
  const row = await db
    .selectFrom('channel_members')
    .select('state_version')
    .where('channel_id', '=', room.channelId)
    .where('user_id', '=', room.members[name]?.userId ?? '')
    .executeTakeFirstOrThrow();
  return { version: row.state_version };
};

describe('integration: CHANNEL_STATE carries the order the numbers were written in', () => {
  test('every message and every read that moves the position counts one, a repeat counts none', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const alice = room.members['alice'];
      const bob = room.members['bob'];
      if (alice === undefined || bob === undefined) throw new Error('room');
      expect(await stored(db, room, 'bob')).toEqual({ version: 0 });

      const first = await sendMessage(db, clock, alice.context, { id: nextId(), content: 'one' });
      const second = await sendMessage(db, clock, alice.context, { id: nextId(), content: 'two' });
      expect(first.recipients.find((r) => r.userId === bob.userId)?.version).toBe(1);
      expect(second.recipients.find((r) => r.userId === bob.userId)?.version).toBe(2);

      const read = await markRead(db, clock, bob.context, second.message.id);
      expect(read).toMatchObject({ moved: true, version: 3 });
      const repeat = await markRead(db, clock, bob.context, second.message.id);
      expect(repeat).toMatchObject({ moved: false, version: 3 });
      // Nothing in the senders' own row moved: they are told nothing about their own message.
      expect(await stored(db, room, 'alice')).toEqual({ version: 0 });
    });
  });

  test('a retried send tells the version the rows hold now, not the one it first answered with', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const alice = room.members['alice'];
      const bob = room.members['bob'];
      if (alice === undefined || bob === undefined) throw new Error('room');
      const input = { id: nextId(), content: 'one' };
      const first = await sendMessage(db, clock, alice.context, input);
      await sendMessage(db, clock, alice.context, { id: nextId(), content: 'two' });
      const again = await sendMessage(db, clock, alice.context, input);
      expect(first.recipients.find((r) => r.userId === bob.userId)?.version).toBe(1);
      expect(again.recipients.find((r) => r.userId === bob.userId)?.version).toBe(2);
    });
  });
});

describe('integration: THREAD_UPDATED and REACTIONS_UPDATED carry the root’s count of changes', () => {
  test('a reply, a resolution and a reopening each count one; the frames say so', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const alice = room.members['alice'];
      const bob = room.members['bob'];
      if (alice === undefined || bob === undefined) throw new Error('room');
      const { bus, frames } = recording();
      const dependencies = { atomically: atomicallyOn(db), clock, bus };

      const root = await send(dependencies, alice.context, { id: nextId(), content: 'q' });
      await send(dependencies, bob.context, {
        id: nextId(),
        content: 'a',
        parentId: root.id,
      });
      await setResolved(dependencies, alice.userId, root.id, true);
      await setResolved(dependencies, alice.userId, root.id, true); // nothing changed: nothing told
      await setResolved(dependencies, alice.userId, root.id, false);

      expect(versionsOf(frames, 'THREAD_UPDATED')).toEqual([1, 2, 3]);
    });
  });

  test('a reaction counts one on the same counter, a repeat counts none, and a retraction counts one', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const alice = room.members['alice'];
      const bob = room.members['bob'];
      if (alice === undefined || bob === undefined) throw new Error('room');
      const { bus, frames } = recording();
      const dependencies = { atomically: atomicallyOn(db), clock, bus };
      const root = await send(dependencies, alice.context, { id: nextId(), content: 'q' });
      await send(dependencies, bob.context, { id: nextId(), content: 'a', parentId: root.id });
      const session = await db
        .insertInto('sessions')
        .values({
          user_id: bob.userId,
          token_hash: `h-${crypto.randomUUID()}`,
          expires_at: new Date(NOW.getTime() + 86_400_000),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const caller = { userId: bob.userId, sessionId: session.id };

      await setReaction(dependencies, caller, root.id, '👍', true);
      await setReaction(dependencies, caller, root.id, '👍', true);
      await setReaction(dependencies, caller, root.id, '👍', false);

      // The reply made the root's count 1; the reaction and its retraction are 2 and 3.
      expect(versionsOf(frames, 'THREAD_UPDATED')).toEqual([1]);
      expect(versionsOf(frames, 'REACTIONS_UPDATED')).toEqual([2, 3]);
    });
  });
});
