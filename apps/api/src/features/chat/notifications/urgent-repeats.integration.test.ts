import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type ClonedDatabase,
  type Executor,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import { messageId } from '@purlay/types';
import type { PushSender } from '../../../modules/push/sender';
import type { PushWork } from '../../../platform/push-work';
import type { Clock } from '../../../platform/clock';
import { atomicallyOn } from '../../../platform/transactions';
import { holdOpen } from '../../../testing/gates';
import { movable } from '../../../testing/push-world';
import { aRoom, type Room } from '../../../testing/rooms';
import { setNotificationLevel } from '../channels/notification-level';
import { reviseMessage } from '../messages/edit';
import { sendMessage, type OutgoingMessage } from '../messages/messages';
import { deliverUrgentRepeats } from './urgent-repeats';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000);

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

const member = (room: Room, name: string): NonNullable<Room['members'][string]> => {
  const person = room.members[name];
  if (person === undefined) throw new Error(`The room has no ${name}`);
  return person;
};

const write = async (room: Room, clock: Clock, input: OutgoingMessage): Promise<void> => {
  await atomicallyOn(cloned.db)(async (tx) => {
    await sendMessage(tx, clock, member(room, 'alice').context, input);
  });
};

const schedules = async (
  db: Executor,
  room: Room,
): Promise<{ id: string; message_id: string; user_id: string; next_at: Date }[]> =>
  await db
    .selectFrom('urgent_message_repeats as repeat')
    .innerJoin('notifications as notice', 'notice.id', 'repeat.notification_id')
    .select(['notice.id', 'notice.message_id', 'notice.user_id', 'repeat.next_at'])
    .where('notice.workspace_id', '=', room.workspaceId)
    .execute();

const testingPush = (capture: NonNullable<PushSender['capture']>): PushSender => ({
  capture,
  told: () => undefined,
  toldInbox: () => undefined,
  releaseHeld: () => Promise.resolve(),
  flush: () => Promise.resolve(),
});

describe('integration: scheduling a repeat with an original urgent notice', () => {
  test('a failed original capture rolls back the notice and repeat together', async () => {
    const db = cloned.db;
    const clock = movable(NOW);
    const room = await aRoom(db, ['alice', 'bob'], { type: 'direct_message' });
    const id = messageId(NOW);
    const failure = await atomicallyOn(db)(async (tx) => {
      await sendMessage(
        tx,
        clock,
        member(room, 'alice').context,
        { id, content: 'look', priority: 'urgent' },
        undefined,
        () => Promise.reject(new Error('initial capture failed')),
      );
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ message: 'initial capture failed' });
    expect(await schedules(db, room)).toEqual([]);
    expect(
      await db.selectFrom('notifications').select('id').where('message_id', '=', id).execute(),
    ).toEqual([]);
    expect(await db.selectFrom('messages').select('id').where('id', '=', id).execute()).toEqual([]);
  });

  test('only an original directed notification repeats, even if the original was quiet', async () => {
    const db = cloned.db;
    const clock = movable(NOW);
    const room = await aRoom(db, ['alice', 'bob', 'carol', 'dave']);
    const bob = member(room, 'bob');
    const carol = member(room, 'carol');
    const dave = member(room, 'dave');
    await atomicallyOn(db)(async (tx) => {
      await setNotificationLevel(tx, clock, carol.context, 'all');
    });
    await db
      .updateTable('workspace_members')
      .set({ is_deep_work_active: true, deep_work_until: at(3) })
      .where('workspace_id', '=', room.workspaceId)
      .where('user_id', '=', bob.userId)
      .execute();
    const content = `@${bob.username} look`;
    await write(room, clock, { id: messageId(NOW), content, priority: 'important' });
    const id = messageId(NOW);
    await write(room, clock, { id, content, priority: 'urgent' });
    await write(room, clock, { id, content, priority: 'urgent' });
    await atomicallyOn(db)(async (tx) => {
      await reviseMessage(
        tx,
        clock,
        member(room, 'alice').userId,
        id,
        `${content} @${dave.username}`,
      );
    });
    expect(await schedules(db, room)).toMatchObject([
      { message_id: id, user_id: bob.userId, next_at: at(2) },
    ]);
    const work: PushWork[] = [];
    const push = testingPush((_tx, _now, jobs) => {
      work.push(...jobs);
      return Promise.resolve();
    });
    clock.to(at(2));
    expect(await deliverUrgentRepeats({ database: db, clock, push })).toBe(0);
    clock.to(at(4));
    expect(await deliverUrgentRepeats({ database: db, clock, push })).toBe(1);
    expect(work).toMatchObject([{ createdAt: at(4), repeat: { expiresAt: at(6) } }]);
    await db.deleteFrom('notifications').where('message_id', '=', id).execute();
    expect(await schedules(db, room)).toEqual([]);
  });

  test('a recipient who already read past the original root gets no repeat', async () => {
    const db = cloned.db;
    const clock = movable(at(1));
    const room = await aRoom(db, ['alice', 'bob'], { type: 'direct_message' });
    const newer = messageId(at(1));
    await write(room, clock, { id: newer, content: 'later' });
    await db
      .updateTable('channel_members')
      .set({ last_read_message_id: newer })
      .where('channel_id', '=', room.channelId)
      .where('user_id', '=', member(room, 'bob').userId)
      .execute();
    const older = messageId(NOW);
    await write(room, clock, { id: older, content: 'late arrival', priority: 'urgent' });
    expect(
      (
        await db
          .selectFrom('notifications')
          .select('read_at')
          .where('message_id', '=', older)
          .executeTakeFirst()
      )?.read_at,
    ).toBeInstanceOf(Date);
    expect(await schedules(db, room)).toEqual([]);
  });

  test('downtime skips missed slots, final eligible repeat expires at +20, and the cursor is cleaned', async () => {
    const db = cloned.db;
    const clock = movable(NOW);
    const room = await aRoom(db, ['alice', 'bob'], { type: 'direct_message' });
    const id = messageId(NOW);
    await write(room, clock, { id, content: 'look', priority: 'urgent' });
    const work: PushWork[] = [];
    const push = testingPush((_tx, _now, jobs) => {
      work.push(...jobs);
      return Promise.resolve();
    });
    const dependencies = { database: db, clock, push };
    clock.to(at(1));
    expect(await deliverUrgentRepeats(dependencies)).toBe(0);
    clock.to(at(7));
    expect(await deliverUrgentRepeats(dependencies)).toBe(1);
    expect(await deliverUrgentRepeats(dependencies)).toBe(0);
    clock.to(at(19));
    expect(await deliverUrgentRepeats(dependencies)).toBe(1);
    expect(await schedules(db, room)).toMatchObject([{ next_at: at(20) }]);
    clock.to(at(20));
    expect(await deliverUrgentRepeats(dependencies)).toBe(0);
    expect(await schedules(db, room)).toEqual([]);
    expect(work).toMatchObject([
      {
        source: 'message',
        module: 'chat',
        kind: 'urgent_repeat',
        recordId: id,
        createdAt: at(6),
        repeat: { expiresAt: at(8) },
      },
      {
        source: 'message',
        module: 'chat',
        kind: 'urgent_repeat',
        recordId: id,
        createdAt: at(18),
        repeat: { expiresAt: at(20) },
      },
    ]);
    expect(work[0]?.sourceId).not.toBe(work[1]?.sourceId);
  });

  test('turning urgent off and reading on another device suppress repeats', async () => {
    const db = cloned.db;
    const clock = movable(NOW);
    const room = await aRoom(db, ['alice', 'bob'], { type: 'direct_message' });
    const id = messageId(NOW);
    await write(room, clock, { id, content: 'look', priority: 'urgent' });
    const push = testingPush(() => Promise.reject(new Error('unexpected repeat')));
    await db
      .updateTable('workspaces')
      .set({ urgent_messages_enabled: false })
      .where('id', '=', room.workspaceId)
      .execute();
    clock.to(at(2));
    expect(await deliverUrgentRepeats({ database: db, clock, push })).toBe(0);
    await db
      .updateTable('workspaces')
      .set({ urgent_messages_enabled: true })
      .where('id', '=', room.workspaceId)
      .execute();
    await db
      .updateTable('notifications')
      .set({ read_at: at(3) })
      .where('message_id', '=', id)
      .execute();
    clock.to(at(4));
    expect(await deliverUrgentRepeats({ database: db, clock, push })).toBe(0);
    expect(await schedules(db, room)).toMatchObject([{ next_at: at(6) }]);
    await db.deleteFrom('notifications').where('message_id', '=', id).execute();
  });

  test('a locked workspace does not hold another workspace’s due repeat', async () => {
    const db = cloned.db;
    const clock = movable(NOW);
    const first = await aRoom(db, ['alice', 'bob'], { type: 'direct_message' });
    const other = await aRoom(db, ['alice', 'bob'], { type: 'direct_message' });
    await write(first, clock, { id: messageId(NOW), content: 'first', priority: 'urgent' });
    await write(other, clock, { id: messageId(NOW), content: 'another', priority: 'urgent' });

    const held = holdOpen(atomicallyOn(db));
    const locked = held.atomically(async (tx) => {
      await tx
        .selectFrom('workspaces')
        .select('id')
        .where('id', '=', first.workspaceId)
        .forUpdate()
        .execute();
    });
    const work: PushWork[] = [];
    const push = testingPush((_tx, _now, jobs) => {
      work.push(...jobs);
      return Promise.resolve();
    });
    clock.to(at(2));
    try {
      await Promise.race([locked, held.holding]);
      expect(await deliverUrgentRepeats({ database: db, clock, push })).toBe(1);
      expect(work.map((job) => job.workspaceId)).toEqual([other.workspaceId]);
    } finally {
      held.release();
      await locked;
    }
    expect(await deliverUrgentRepeats({ database: db, clock, push })).toBe(1);
    expect(work.map((job) => job.workspaceId)).toEqual([other.workspaceId, first.workspaceId]);
    await db
      .deleteFrom('notifications')
      .where('workspace_id', 'in', [first.workspaceId, other.workspaceId])
      .execute();
  });

  test('capture rollback leaves the same slot for retry and two workers cannot claim it', async () => {
    const db = cloned.db;
    const clock = movable(NOW);
    const room = await aRoom(db, ['alice', 'bob'], { type: 'direct_message' });
    const id = messageId(NOW);
    await write(room, clock, { id, content: 'look', priority: 'urgent' });
    clock.to(at(2));
    const attempts: string[] = [];
    const capture: NonNullable<PushSender['capture']> = (_tx, _now, jobs) => {
      attempts.push(...jobs.map((job) => job.sourceId));
      return Promise.reject(new Error('capture failed'));
    };
    const failure = await deliverUrgentRepeats({
      database: db,
      clock,
      push: testingPush(capture),
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ message: 'capture failed' });
    expect(await schedules(db, room)).toMatchObject([{ next_at: at(2) }]);
    const { promise: started, resolve: markStarted } = Promise.withResolvers<undefined>();
    const { promise: resume, resolve: release } = Promise.withResolvers<undefined>();
    const push = testingPush(async (_tx, _now, jobs) => {
      attempts.push(...jobs.map((job) => job.sourceId));
      markStarted(undefined);
      await resume;
    });
    const earlier = deliverUrgentRepeats({ database: db, clock, push });
    try {
      await Promise.race([earlier, started]);
      expect(await deliverUrgentRepeats({ database: db, clock, push })).toBe(0);
    } finally {
      release(undefined);
    }
    expect(await earlier).toBe(1);
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts).size).toBe(1);
  });
});
