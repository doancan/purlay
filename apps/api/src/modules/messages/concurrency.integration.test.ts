/**
 * What the row locks are for, shown by holding one open (H-API 8).
 *
 * Three places take a lock so that two callers take turns instead of both acting on what
 * neither has committed: a person's read position (`markRead`, `FOR UPDATE` on the membership),
 * a thread's resolution (`setResolved`, `FOR UPDATE` on the root), a message being edited
 * (`reviseMessage`, `FOR UPDATE` on the message), and a message's reaction
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
  CLONE_HOOK_MS,
} from '@purlay/db';
import { messageId, type ServerFrame } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import type { EventBus } from '../../platform/events';
import { atomicallyOn } from '../../platform/transactions';
import { sql } from '@purlay/db';
import { BLOCKED_FOR_MS, holdOpen } from '../../testing/gates';
import { aRoom, notificationsOf, type Room } from '../../testing/rooms';
import { markRead } from '../channels/read-state';
import { leaveChannel } from '../channels/settings';
import { REACTION_KINDS_MAX, setReaction } from '../reactions/reactions';
import { sendMessage } from './messages';
import { setResolved } from './threads';
import { reviseMessage } from './edit';
import { removeMessage } from './delete';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
let tick = 0;
const nextId = (): string => messageId(new Date(NOW.getTime() + (tick += 1) * 10));

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
});

const idOf = (room: Room, name: string): string => room.members[name]?.userId ?? '';

const recordingBus = (): { bus: EventBus; frames: ServerFrame[] } => {
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
  return { frames, bus };
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

describe('integration: an edit racing a delete', () => {
  test('the edit that waited finds the message deleted, and does not bring its words back', async () => {
    const db = cloned.db;
    const room = await aRoom(db, ['alice']);
    const alice = room.members['alice'];
    if (alice === undefined) throw new Error('room');
    const id = (await sendMessage(db, clock, alice.context, { id: nextId(), content: 'mine' }))
      .message.id;

    // The delete has written and waits, uncommitted, holding the row.
    const deleting = holdOpen(atomicallyOn(db));
    const deleted = deleting.atomically(async (transaction) => {
      await transaction
        .updateTable('messages')
        .set({ deleted_at: NOW, content: '' })
        .where('id', '=', id)
        .execute();
    });
    await deleting.holding;
    // The edit's guard reads what is committed — not deleted — and lets it through to the lock.
    const editing = atomicallyOn(db)(
      async (transaction) =>
        await reviseMessage(transaction, clock, idOf(room, 'alice'), id, 'back'),
    );
    expect(await settlesWithin(editing, BLOCKED_FOR_MS)).toBe(false);
    deleting.release();
    await deleted;
    const outcome = await editing.then(
      () => 'edited',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(outcome).toBe('Message not found.');
    const row = await db
      .selectFrom('messages')
      .select(['content', 'edited_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ content: '', edited_at: null });
  });
});

describe('integration: two edits naming the same person at once', () => {
  // Held by the notification's unique key as much as by the lock: an outcome, not a lock's proof.
  test('they are told once, and counted once', async () => {
    const db = cloned.db;
    const room = await aRoom(db, ['alice', 'bob']);
    const alice = room.members['alice'];
    const bob = room.members['bob'];
    if (alice === undefined || bob === undefined) throw new Error('room');
    const id = (await sendMessage(db, clock, alice.context, { id: nextId(), content: 'hi' }))
      .message.id;

    const first = holdOpen(atomicallyOn(db));
    const one = first.atomically(
      async (transaction) =>
        await reviseMessage(transaction, clock, alice.userId, id, `hi @${bob.username}`),
    );
    await first.holding;
    const two = atomicallyOn(db)(
      async (transaction) =>
        await reviseMessage(transaction, clock, alice.userId, id, `hello @${bob.username}`),
    );
    expect(await settlesWithin(two, BLOCKED_FOR_MS)).toBe(false);
    first.release();
    await Promise.all([one, two]);

    expect(
      (await notificationsOf(db, bob.userId)).filter((n) => n.type === 'mention'),
    ).toHaveLength(1);
    const member = await db
      .selectFrom('channel_members')
      .select(['unread_count', 'unread_mention_count'])
      .where('channel_id', '=', room.channelId)
      .where('user_id', '=', bob.userId)
      .executeTakeFirstOrThrow();
    expect(member).toEqual({ unread_count: 1, unread_mention_count: 1 });
  });
});

describe('integration: an edit waiting on another', () => {
  test('is judged against what the first wrote: the old words back are an edit, not a no-op', async () => {
    const db = cloned.db;
    const room = await aRoom(db, ['alice']);
    const alice = room.members['alice'];
    if (alice === undefined) throw new Error('room');
    const id = (await sendMessage(db, clock, alice.context, { id: nextId(), content: 'v0' }))
      .message.id;

    const first = holdOpen(atomicallyOn(db));
    const one = first.atomically(
      async (transaction) => await reviseMessage(transaction, clock, alice.userId, id, 'v1'),
    );
    await first.holding;
    // Read without the lock this would see the committed 'v0', call it the same words, and
    // answer without writing — and 'v1' would win though it was the earlier request.
    const two = atomicallyOn(db)(
      async (transaction) => await reviseMessage(transaction, clock, alice.userId, id, 'v0'),
    );
    expect(await settlesWithin(two, BLOCKED_FOR_MS)).toBe(false);
    first.release();
    await Promise.all([one, two]);
    const row = await db
      .selectFrom('messages')
      .select('content')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.content).toBe('v0');
  });
});

describe('integration: two deletes at once', () => {
  test('the second finds it deleted: the counters come down once', async () => {
    const db = cloned.db;
    const room = await aRoom(db, ['alice', 'bob']);
    const alice = room.members['alice'];
    const bob = room.members['bob'];
    if (alice === undefined || bob === undefined) throw new Error('room');
    await sendMessage(db, clock, alice.context, { id: nextId(), content: 'kept' });
    const id = (
      await sendMessage(db, clock, alice.context, { id: nextId(), content: `@${bob.username}` })
    ).message.id;

    const first = holdOpen(atomicallyOn(db));
    const one = first.atomically(
      async (transaction) => await removeMessage(transaction, clock, alice.userId, id),
    );
    await first.holding;
    const two = atomicallyOn(db)(
      async (transaction) => await removeMessage(transaction, clock, alice.userId, id),
    );
    expect(await settlesWithin(two, BLOCKED_FOR_MS)).toBe(false);
    first.release();
    const [byFirst, bySecond] = await Promise.all([one, two]);
    expect([byFirst.removed, bySecond.removed]).toEqual([true, false]);
    const member = await db
      .selectFrom('channel_members')
      .select(['unread_count', 'unread_mention_count'])
      .where('channel_id', '=', room.channelId)
      .where('user_id', '=', bob.userId)
      .executeTakeFirstOrThrow();
    expect(member).toEqual({ unread_count: 1, unread_mention_count: 0 });
  });
});

describe('integration: a delete while the person it named reads the channel', () => {
  test('they take turns, in one lock order, and both commit', async () => {
    const db = cloned.db;
    const room = await aRoom(db, ['alice', 'bob']);
    const alice = room.members['alice'];
    const bob = room.members['bob'];
    if (alice === undefined || bob === undefined) throw new Error('room');
    const id = (
      await sendMessage(db, clock, alice.context, { id: nextId(), content: `@${bob.username} hi` })
    ).message.id;

    // Bob's read has taken his membership row, as `markRead` does first, and pauses there.
    let locked: () => void = () => undefined;
    let proceed: () => void = () => undefined;
    const hasLock = new Promise<void>((open) => {
      locked = open;
    });
    const mayProceed = new Promise<void>((open) => {
      proceed = open;
    });
    const reading = atomicallyOn(db)(async (transaction) => {
      await transaction
        .selectFrom('channel_members')
        .select('user_id')
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', bob.userId)
        .forUpdate()
        .execute();
      locked();
      await mayProceed;
      return await markRead(transaction, clock, bob.context, id);
    });
    await hasLock;
    // Alice deletes it meanwhile. Taking the memberships before the notifications, it waits here
    // holding nothing Bob's read will need; the other way round, each waits for the other.
    const deleting = atomicallyOn(db)(
      async (transaction) => await removeMessage(transaction, clock, alice.userId, id),
    );
    expect(await settlesWithin(deleting, BLOCKED_FOR_MS)).toBe(false);
    proceed();
    const outcomes = await Promise.allSettled([reading, deleting]);
    expect(
      outcomes.map((outcome) =>
        outcome.status === 'fulfilled' ? 'committed' : String(outcome.reason),
      ),
    ).toEqual(['committed', 'committed']);
  });
});

describe('integration: several people writing into one channel at once (#668)', () => {
  test('every send succeeds — the members are counted in one lock order — and every count is right', async () => {
    const db = cloned.db;
    const names = ['alice', 'bob', 'carol', 'dave', 'erin'];
    const room = await aRoom(db, names);
    const atomically = atomicallyOn(db);
    const EACH = 25;
    // Before the members' rows were locked in one order, a multi-row update reached them in the
    // order of each snapshot's row versions, and two senders could each hold a row the other
    // needed: measured, 13 of 418 sends from four writers failed with a deadlock.
    const outcomes = await Promise.allSettled(
      names.flatMap((name) =>
        Array.from({ length: EACH }, async () => {
          const member = room.members[name];
          if (member === undefined) throw new Error(`no member ${name}`);
          return await atomically(
            async (transaction) =>
              await sendMessage(transaction, clock, member.context, {
                id: nextId(),
                content: `from ${name}`,
              }),
          );
        }),
      ),
    );
    const failed = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(failed.map((outcome) => String(outcome.reason))).toEqual([]);
    const counts = await db
      .selectFrom('channel_members')
      .select(['user_id', 'unread_count'])
      .where('channel_id', '=', room.channelId)
      .execute();
    // Each has read nothing: every message the others wrote is waiting for them.
    expect(counts.map((row) => row.unread_count)).toEqual(
      names.map(() => EACH * (names.length - 1)),
    );
  }, 60_000);
});

describe('integration: leaving a channel while somebody writes in it (#669)', () => {
  /** Resolves once this many of the database's sessions are waiting on a lock. */
  const waitingOnLocks = async (db: ClonedDatabase['db'], count: number): Promise<void> => {
    for (let tries = 0; tries < 200; tries += 1) {
      const { rows } = await sql<{ waiting: number }>`
        select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
      `.execute(db);
      if ((rows[0]?.waiting ?? 0) >= count) return;
      await Bun.sleep(10);
    }
    throw new Error(`never saw ${String(count)} sessions waiting on a lock`);
  };

  test('both finish: the leave takes its membership before the channel row, the order a send takes them in', async () => {
    const db = cloned.db;
    const later = fixedClock(new Date(NOW.getTime() + 60_000));
    // Released, either may take the channel row first — PostgreSQL wakes row-lock waiters in no
    // fixed order — so the interleaving is set up ten times; it deadlocked when the leave won.
    for (let round = 0; round < 10; round += 1) {
      const room = await aRoom(db, ['alice', 'frank']);
      const alice = room.members['alice'];
      const frank = room.members['frank'];
      if (alice === undefined || frank === undefined) throw new Error('room');

      // The channel row is held, so each of the two stops at it — the leave first, then the send,
      // which by then holds the memberships it counts, frank's among them. Taken in opposite orders
      // (the leave: channel, then its membership; the send: memberships, then the channel) that is
      // a deadlock whenever the leave is woken first.
      const blocker = holdOpen(atomicallyOn(db));
      const blocking = blocker.atomically(
        async (transaction) =>
          await transaction
            .selectFrom('channels')
            .select('id')
            .where('id', '=', room.channelId)
            .forNoKeyUpdate()
            .execute(),
      );
      await blocker.holding;
      const leaving = atomicallyOn(db)(
        async (transaction) => await leaveChannel(transaction, frank.context),
      );
      await waitingOnLocks(db, 1);
      const sending = atomicallyOn(db)(
        async (transaction) =>
          await sendMessage(transaction, later, alice.context, { id: nextId(), content: 'here?' }),
      );
      await waitingOnLocks(db, 2);
      blocker.release();
      await blocking;
      const outcomes = await Promise.allSettled([leaving, sending]);
      expect(
        outcomes
          .filter((outcome) => outcome.status === 'rejected')
          .map((outcome) => String(outcome.reason)),
      ).toEqual([]);
    }
  }, 30_000);
});

describe('integration: an edit naming two people while somebody writes (#669)', () => {
  const waitingOnLocks = async (db: ClonedDatabase['db'], count: number): Promise<void> => {
    for (let tries = 0; tries < 200; tries += 1) {
      const { rows } = await sql<{ waiting: number }>`
        select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
      `.execute(db);
      if ((rows[0]?.waiting ?? 0) >= count) return;
      await Bun.sleep(10);
    }
    throw new Error(`never saw ${String(count)} sessions waiting on a lock`);
  };

  test('both finish, whatever plan the edit gets: it locks the people it names in the order a send does', async () => {
    const db = cloned.db;
    // After the room is made: an edit counts a mention only for who was in the channel when the
    // message was written (`joined_at <= written`), and a message dated before they joined counts
    // nobody — a test that passes by locking nothing.
    const later = fixedClock(new Date(Date.now() + 60_000));
    // Found by a chaos soak (one 500 in 3,098 requests): on a small table the planner reads the
    // edit's `user_id in (…)` with a sequential scan, in the rows' physical order. The edit's
    // transaction turns the index scans off so the test does not depend on the plan: touching the
    // lower-id row first puts its newest version after the other's. A third transaction holds the
    // higher row; the edit waits for it first, then the send takes the lower and waits for it too.
    // Released, the first waiter — the edit — takes it, and then needs the lower row the send holds.
    for (let round = 0; round < 10; round += 1) {
      const room = await aRoom(db, ['erin', 'walt', 'tess', 'troy']);
      const erin = room.members['erin'];
      const walt = room.members['walt'];
      if (erin === undefined || walt === undefined) throw new Error('room');
      const [low, high] = ['tess', 'troy']
        .map((name) => room.members[name])
        .filter((m): m is NonNullable<typeof m> => m !== undefined)
        .sort((a, b) => (a.userId < b.userId ? -1 : 1));
      if (low === undefined || high === undefined) throw new Error('room');
      const own = (
        await sendMessage(db, later, erin.context, {
          id: messageId(new Date(Date.now() + 1_000 + round)),
          content: 'draft',
        })
      ).message.id;
      await db
        .updateTable('channel_members')
        .set({ state_version: sql<number>`state_version + 1` })
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', low.userId)
        .execute();

      const blocker = holdOpen(atomicallyOn(db));
      const blocking = blocker.atomically(
        async (transaction) =>
          await transaction
            .selectFrom('channel_members')
            .select('user_id')
            .where('channel_id', '=', room.channelId)
            .where('user_id', '=', high.userId)
            .forNoKeyUpdate()
            .execute(),
      );
      await blocker.holding;
      const editing = atomicallyOn(db)(async (transaction) => {
        await sql`set local enable_indexscan = off`.execute(transaction);
        await sql`set local enable_bitmapscan = off`.execute(transaction);
        await sql`set local enable_indexonlyscan = off`.execute(transaction);
        return await reviseMessage(
          transaction,
          later,
          erin.userId,
          own,
          `@${low.username} @${high.username}`,
        );
      });
      await waitingOnLocks(db, 1);
      const sending = atomicallyOn(db)(
        async (transaction) =>
          await sendMessage(transaction, later, walt.context, {
            id: messageId(new Date(Date.now() + 2_000 + round)),
            content: 'hi',
          }),
      );
      await waitingOnLocks(db, 2);
      blocker.release();
      await blocking;
      const outcomes = await Promise.allSettled([sending, editing]);
      expect(
        outcomes
          .filter((outcome) => outcome.status === 'rejected')
          .map((outcome) => String(outcome.reason)),
      ).toEqual([]);
      // Not vacuous: the edit did count both people it named.
      const counted = await db
        .selectFrom('channel_members')
        .select('unread_mention_count')
        .where('channel_id', '=', room.channelId)
        .where('user_id', 'in', [low.userId, high.userId])
        .execute();
      expect(counted.map((row) => row.unread_mention_count)).toEqual([1, 1]);
    }
  }, 30_000);
});
