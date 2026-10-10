/**
 * What the row locks are for, shown by holding one open (H-API 8).
 *
 * Three places take a lock so that two callers take turns instead of both acting on what
 * neither has committed: a person's read position (`markRead`, `FOR UPDATE` on the membership),
 * a thread's resolution (`setResolved`, `FOR UPDATE` on the root), and a message's reaction
 * kinds (`serialiseReactionsTo`, an advisory lock). Each test makes the first caller finish and
 * *wait, uncommitted* (`testing/gates.ts`), starts the second, and releases the first — so the
 * outcome is decided by the lock alone. `scripts/mutations.ts` removes each lock and requires
 * these to fail.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type ClonedDatabase,
} from '@purlay/db';
import { messageId, type ServerFrame } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import type { EventBus } from '../../platform/events';
import { atomicallyOn } from '../../platform/transactions';
import { BLOCKED_FOR_MS, holdOpen } from '../../testing/gates';
import { aRoom, notificationsOf, type Room } from '../../testing/rooms';
import { markRead } from '../channels/read-state';
import { REACTION_KINDS_MAX, setReaction } from '../reactions/reactions';
import { sendMessage } from './messages';
import { setResolved } from './threads';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
let tick = 0;
const nextId = (): string => messageId(new Date(NOW.getTime() + (tick += 1) * 10));

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
});
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
});

const idOf = (room: Room, name: string): string => room.members[name]?.userId ?? '';

const recordingBus = (): { bus: EventBus; frames: ServerFrame[] } => {
  const frames: ServerFrame[] = [];
  return {
    frames,
    bus: {
      publish: (_topic, frame) => {
        frames.push(frame);
        return Promise.resolve();
      },
      subscribe: () => false,
      unsubscribe: () => undefined,
      forget: () => undefined,
    },
  };
};

/** Resolves true if the promise settles within the window, false if it is still waiting. */
const settlesWithin = async (work: Promise<unknown>, ms: number): Promise<boolean> =>
  await Promise.race([
    work.then(
      () => true,
      () => true,
    ),
    Bun.sleep(ms).then(() => false),
  ]);

describe('integration: two devices of one person reading at once', () => {
  test('the later position wins whichever transaction commits last, and never moves back', async () => {
    const db = cloned.db;
    const room = await aRoom(db, ['alice', 'bob']);
    const alice = room.members['alice'];
    const bob = room.members['bob'];
    if (alice === undefined || bob === undefined) throw new Error('room');
    const older = (await sendMessage(db, clock, alice.context, { id: nextId(), content: 'one' }))
      .message.id;
    const newer = (await sendMessage(db, clock, alice.context, { id: nextId(), content: 'two' }))
      .message.id;

    // The laptop has read to the newer message and is about to commit; the phone, a moment
    // behind, reports the older one.
    const laptop = holdOpen(atomicallyOn(db));
    const first = laptop.atomically(async (tx) => await markRead(tx, clock, bob.context, newer));
    await laptop.holding;
    const phone = atomicallyOn(db)(async (tx) => await markRead(tx, clock, bob.context, older));
    // With the lock the phone waits for the laptop; without it, the phone is stuck at its
    // UPDATE on the same row instead — either way it cannot finish first.
    expect(await settlesWithin(phone, BLOCKED_FOR_MS)).toBe(false);
    laptop.release();
    const [, behind] = await Promise.all([first, phone]);

    // The phone found the position already past its own: it moved nothing and says so.
    expect(behind.moved).toBe(false);
    expect(behind.state.lastReadMessageId).toBe(newer);
    const row = await db
      .selectFrom('channel_members')
      .select(['last_read_message_id', 'state_version'])
      .where('channel_id', '=', room.channelId)
      .where('user_id', '=', bob.userId)
      .executeTakeFirstOrThrow();
    expect(row.last_read_message_id).toBe(newer);
    // The laptop's read counted one change (the two sends before it counted two); the phone's
    // did not move the row.
    expect(row.state_version).toBe(3);
  });
});

describe('integration: two people resolving at once', () => {
  test('the second finds the thread already closed: one change, one frame, one notification', async () => {
    const db = cloned.db;
    const room = await aRoom(db, ['alice', 'bob', 'carol']);
    const alice = room.members['alice'];
    const bob = room.members['bob'];
    if (alice === undefined || bob === undefined) throw new Error('room');
    const root = (await sendMessage(db, clock, alice.context, { id: nextId(), content: 'q' }))
      .message.id;
    await sendMessage(db, clock, bob.context, { id: nextId(), content: 'a', parentId: root });
    const { bus, frames } = recordingBus();

    const bobFirst = holdOpen(atomicallyOn(db));
    const first = setResolved(
      { atomically: bobFirst.atomically, clock, bus },
      idOf(room, 'bob'),
      root,
      true,
    );
    await bobFirst.holding;
    const second = setResolved(
      { atomically: atomicallyOn(db), clock, bus },
      idOf(room, 'carol'),
      root,
      true,
    );
    expect(await settlesWithin(second, BLOCKED_FOR_MS)).toBe(false);
    bobFirst.release();
    const [closedByBob, closedByCarol] = await Promise.all([first, second]);

    // Carol's call came second, so Bob is the resolver in both answers.
    expect(closedByBob.thread?.resolvedBy?.id).toBe(idOf(room, 'bob'));
    expect(closedByCarol.thread?.resolvedBy?.id).toBe(idOf(room, 'bob'));
    expect(frames.filter((frame) => frame.event === 'THREAD_UPDATED')).toHaveLength(1);
    const told = (await notificationsOf(db, idOf(room, 'alice'))).filter(
      (n) => n.type === 'thread_resolved',
    );
    expect(told).toHaveLength(1);
  });
});

describe('integration: two people adding different new reactions at the cap', () => {
  test('one is refused, so a message never carries more kinds than the cap', async () => {
    const db = cloned.db;
    const room = await aRoom(db, ['alice', 'bob', 'carol']);
    const alice = room.members['alice'];
    const bob = room.members['bob'];
    const carol = room.members['carol'];
    if (alice === undefined || bob === undefined || carol === undefined) throw new Error('room');
    const root = (await sendMessage(db, clock, alice.context, { id: nextId(), content: 'q' }))
      .message.id;
    const session = async (userId: string): Promise<{ userId: string; sessionId: string }> => {
      const row = await db
        .insertInto('sessions')
        .values({
          user_id: userId,
          token_hash: `h-${crypto.randomUUID()}`,
          expires_at: new Date(NOW.getTime() + 86_400_000),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { userId, sessionId: row.id };
    };
    const bobSession = await session(bob.userId);
    const carolSession = await session(carol.userId);
    const { bus } = recordingBus();
    const plain = { atomically: atomicallyOn(db), clock, bus };

    // One short of the cap, all by Alice.
    const aliceSession = await session(alice.userId);
    for (let kind = 0; kind < REACTION_KINDS_MAX - 1; kind += 1) {
      await setReaction(plain, aliceSession, root, String.fromCodePoint(0x1f600 + kind), true);
    }

    const bobFirst = holdOpen(atomicallyOn(db));
    const first = setReaction(
      { atomically: bobFirst.atomically, clock, bus },
      bobSession,
      root,
      '🅰',
      true,
    );
    await bobFirst.holding;
    const second = setReaction(plain, carolSession, root, '🅱', true).then(
      () => 'added',
      () => 'refused',
    );
    expect(await settlesWithin(second, BLOCKED_FOR_MS)).toBe(false);
    bobFirst.release();
    await first;

    expect(await second).toBe('refused');
    const kinds = await db
      .selectFrom('reactions')
      .select('emoji')
      .where('message_id', '=', root)
      .groupBy('emoji')
      .execute();
    expect(kinds).toHaveLength(REACTION_KINDS_MAX);
  });
});
