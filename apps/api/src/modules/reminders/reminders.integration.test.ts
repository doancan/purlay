import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type ClonedDatabase,
} from '@purlay/db';
import { messageId, type ServerFrame } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { NO_LOG, type EventBus } from '../../platform/events';
import { atomicallyOn } from '../../platform/transactions';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { aRoom, type Room } from '../../testing/rooms';
import { sendMessage } from '../messages/messages';
import { cancelReminder, reminderList, setReminder } from './reminders';
import { deliverReminders } from './delivery';

const clock = fixedClock(new Date('2026-10-28T12:00:00Z'));
const due = fixedClock(new Date('2026-10-28T13:00:00Z'));
let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
});
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
});
const refusalOf = async (attempt: Promise<unknown>): Promise<unknown> => {
  try {
    await attempt;
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
};
const setup = async (): Promise<{
  room: Room;
  user: string;
  other: string;
  message: string;
  events: ServerFrame[];
  dependencies: Parameters<typeof deliverReminders>[0];
}> => {
  const db = cloned.db;
  const room = await aRoom(db, ['alice', 'bob']);
  const alice = room.members['alice'];
  const bob = room.members['bob'];
  if (alice === undefined || bob === undefined) throw new Error('missing test users');
  const sent = await atomicallyOn(db)(
    async (tx) =>
      await sendMessage(tx, clock, alice.context, {
        id: messageId(clock.now()),
        content: 'Remember this',
      }),
  );
  const events: ServerFrame[] = [];
  const bus: EventBus = {
    publish: (_topic, frame) => {
      events.push(frame);
      return Promise.resolve();
    },
    subscribe: () => false,
    unsubscribe: () => {
      /* recorder has no subscriptions */
    },
    forget: () => {
      /* recorder has no subscriptions */
    },
  };
  return {
    room,
    user: alice.userId,
    other: bob.userId,
    message: sent.message.id,
    events,
    dependencies: { database: db, clock: due, bus, log: NO_LOG },
  };
};

describe('integration: private durable reminders', () => {
  test('the bound refuses new reminders while allowing replacement', async () => {
    const { room, user, message } = await setup();
    const db = cloned.db;
    const ids = Array.from({ length: 100 }, () => messageId(clock.now()));
    await db
      .insertInto('messages')
      .values(
        ids.map((id) => ({
          id,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          sender_id: user,
          content: 'Keep',
        })),
      )
      .execute();
    await db
      .insertInto('message_reminders')
      .values(
        ids.map((id) => ({
          user_id: user,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          message_id: id,
          remind_at: due.now(),
        })),
      )
      .execute();
    expect(
      await refusalOf(
        atomicallyOn(db)(
          async (tx) => await setReminder(tx, clock, user, message, due.now().toISOString()),
        ),
      ),
    ).toMatchObject({
      body: {
        code: 'VALIDATION_FAILED',
        details: { fields: { reminders: 'at most 100 pending reminders' } },
      },
    });
    const first = ids[0];
    if (first === undefined) throw new Error('missing test message');
    await atomicallyOn(db)(
      async (tx) => await setReminder(tx, clock, user, first, due.now().toISOString()),
    );
    await db.deleteFrom('message_reminders').where('user_id', '=', user).execute();
  });

  test('Deep Work holds the push while keeping the due reminder in the inbox', async () => {
    const { user, room, message, dependencies } = await setup();
    const db = cloned.db;
    await db
      .updateTable('workspace_members')
      .set({ deep_work_until: new Date(due.now().getTime() + 60_000) })
      .where('workspace_id', '=', room.workspaceId)
      .where('user_id', '=', user)
      .execute();
    await atomicallyOn(db)(
      async (tx) => await setReminder(tx, clock, user, message, due.now().toISOString()),
    );
    expect(await deliverReminders(dependencies)).toBe(1);
    expect(
      await db
        .selectFrom('notifications')
        .select(['suppressed_by_deep_work', 'read_at'])
        .where('user_id', '=', user)
        .where('type', '=', 'reminder')
        .executeTakeFirstOrThrow(),
    ).toEqual({ suppressed_by_deep_work: true, read_at: null });
  });

  test('replacement is one private reminder; cancelling another user’s reminder leaves it intact', async () => {
    const { user, other, room, message } = await setup();
    const db = cloned.db;
    const put = async (): ReturnType<typeof setReminder> =>
      await atomicallyOn(db)(
        async (tx) => await setReminder(tx, clock, user, message, due.now().toISOString()),
      );
    const first = await put();
    expect((await put()).id).toBe(first.id);
    expect(
      await reminderList(db, await requireWorkspaceMembership(db, other, room.workspaceId)),
    ).toEqual([]);
    await atomicallyOn(db)(async (tx) => await cancelReminder(tx, other, message));
    expect(
      await reminderList(db, await requireWorkspaceMembership(db, user, room.workspaceId)),
    ).toHaveLength(1);
    await atomicallyOn(db)(async (tx) => await cancelReminder(tx, user, message));
    expect(
      await reminderList(db, await requireWorkspaceMembership(db, user, room.workspaceId)),
    ).toEqual([]);
  });

  test('two workers deliver one notification after the due time without inventing unread messages', async () => {
    const { user, message, room, dependencies, events } = await setup();
    const db = cloned.db;
    await atomicallyOn(db)(
      async (tx) => await setReminder(tx, clock, user, message, due.now().toISOString()),
    );
    expect(await deliverReminders({ ...dependencies, clock })).toBe(0);
    const before = await db
      .selectFrom('channel_members')
      .select(['unread_count', 'unread_mention_count'])
      .where('channel_id', '=', room.channelId)
      .where('user_id', '=', user)
      .executeTakeFirstOrThrow();
    const delivered = await Promise.all([
      deliverReminders(dependencies),
      deliverReminders(dependencies),
    ]);
    expect(delivered.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await deliverReminders(dependencies)).toBe(0);
    const notes = await db
      .selectFrom('notifications')
      .selectAll()
      .where('user_id', '=', user)
      .where('message_id', '=', message)
      .where('type', '=', 'reminder')
      .execute();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.read_at).toBeNull();
    expect(events.map((event) => event.event)).toEqual([
      'REMINDERS_UPDATED',
      'NOTIFICATIONS_UPDATED',
    ]);
    expect(
      await db
        .selectFrom('channel_members')
        .select(['unread_count', 'unread_mention_count'])
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', user)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
    await atomicallyOn(db)(
      async (tx) => await setReminder(tx, clock, user, message, due.now().toISOString()),
    );
    expect(await deliverReminders(dependencies)).toBe(1);
    const latest = await db
      .selectFrom('notifications')
      .select('id')
      .where('user_id', '=', user)
      .where('message_id', '=', message)
      .where('type', '=', 'reminder')
      .execute();
    expect(latest).toHaveLength(1);
    expect(latest[0]?.id).not.toBe(notes[0]?.id);
  });

  test('deleted messages and revoked access quietly cancel delivery', async () => {
    for (const deleted of [true, false]) {
      const { user, message, room, dependencies } = await setup();
      const db = cloned.db;
      await atomicallyOn(db)(
        async (tx) => await setReminder(tx, clock, user, message, due.now().toISOString()),
      );
      if (deleted)
        await db
          .updateTable('messages')
          .set({ deleted_at: clock.now() })
          .where('id', '=', message)
          .execute();
      else
        await db
          .deleteFrom('workspace_members')
          .where('user_id', '=', user)
          .where('workspace_id', '=', room.workspaceId)
          .execute();
      expect(await deliverReminders(dependencies)).toBe(0);
      expect(
        await db.selectFrom('message_reminders').select('id').where('user_id', '=', user).execute(),
      ).toEqual([]);
      expect(
        await db
          .selectFrom('notifications')
          .select('id')
          .where('user_id', '=', user)
          .where('type', '=', 'reminder')
          .execute(),
      ).toEqual([]);
    }
  });

  test('invalid dates and inaccessible messages are refused', async () => {
    const { user, message } = await setup();
    for (const date of [clock.now().toISOString(), '2030-01-01T00:00:00Z']) {
      expect(
        await refusalOf(
          atomicallyOn(cloned.db)(async (tx) => await setReminder(tx, clock, user, message, date)),
        ),
      ).toMatchObject({ body: { code: 'VALIDATION_FAILED' } });
    }
    expect(
      await refusalOf(
        atomicallyOn(cloned.db)(
          async (tx) =>
            await setReminder(tx, clock, user, messageId(clock.now()), due.now().toISOString()),
        ),
      ),
    ).toMatchObject({ body: { code: 'MESSAGE_NOT_FOUND' } });
  });
});
