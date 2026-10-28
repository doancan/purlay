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
import { aMemoryStore } from '../../testing/storage';
import { discardUpload, storeUpload } from '../attachments/uploads';
import { sweepOrphans } from '../jobs/jobs';
import { sendMessage } from '../messages/messages';
import { cancelScheduledMessage, scheduleMessage, scheduledMessages } from './scheduled';
import { deliverScheduled } from './delivery';

const now = new Date('2026-10-28T12:00:00Z');
const clock = fixedClock(now);
const due = fixedClock(new Date(now.getTime() + 60_000));
const sendAt = due.now().toISOString();
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
  db: ClonedDatabase['db'];
  room: Room;
  alice: Room['members'][string];
  bob: Room['members'][string];
  id: string;
  events: ServerFrame[];
  dependencies: Parameters<typeof deliverScheduled>[0];
  put: (content?: string, attachmentIds?: string[]) => ReturnType<typeof scheduleMessage>;
}> => {
  const db = cloned.db;
  const room = await aRoom(db, ['alice', 'bob']);
  const alice = room.members['alice'];
  const bob = room.members['bob'];
  if (alice === undefined || bob === undefined) throw new Error('missing test members');
  const id = messageId(now);
  const events: ServerFrame[] = [];
  const bus: EventBus = {
    publish: (_topic, frame) => {
      events.push(frame);
      return Promise.resolve();
    },
    subscribe: () => false,
    unsubscribe: () => {
      /* no subscriptions in this recorder */
    },
    forget: () => {
      /* no subscriptions in this recorder */
    },
  };
  const dependencies = { database: db, clock: due, bus, log: NO_LOG };
  const put = async (
    content = 'Tomorrow',
    attachmentIds?: string[],
  ): ReturnType<typeof scheduleMessage> =>
    await atomicallyOn(db)(
      async (tx) =>
        await scheduleMessage(tx, clock, alice.userId, room.channelId, id, {
          content,
          sendAt,
          ...(attachmentIds === undefined ? {} : { attachmentIds }),
        }),
    );
  return { db, room, alice, bob, id, events, dependencies, put };
};

describe('integration: durable scheduled messages', () => {
  test('the personal limit holds while replacement at the limit remains possible', async () => {
    const { db, room, alice, id, put } = await setup();
    await db
      .insertInto('scheduled_messages')
      .values(
        Array.from({ length: 100 }, (_, index) => ({
          id: index === 0 ? id : messageId(now),
          user_id: alice.userId,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          content: 'Pending',
          send_at: new Date(now.getTime() + 86_400_000),
        })),
      )
      .execute();
    await put('Replacement');
    expect(
      await refusalOf(
        atomicallyOn(db)(
          async (tx) =>
            await scheduleMessage(tx, clock, alice.userId, room.channelId, messageId(now), {
              content: 'Extra',
              sendAt,
            }),
        ),
      ),
    ).toMatchObject({ body: { code: 'SCHEDULED_MESSAGE_LIMIT' } });
    // Keep this test's due row out of the later delivery tests' global queue.
    await db.deleteFrom('scheduled_messages').where('user_id', '=', alice.userId).execute();
  });

  test('reply targets must be roots and failed replacements roll back attachment reservations', async () => {
    const { db, room, alice, put, id } = await setup();
    const atomically = atomicallyOn(db);
    const storage = aMemoryStore();
    const context = await requireWorkspaceMembership(db, alice.userId, room.workspaceId);
    const { attachment: file } = await storeUpload({ atomically, storage, log: NO_LOG }, context, {
      id: messageId(now),
      name: 'keep.txt',
      bytes: new Uint8Array([1]),
    });
    await put('Keep', [file.id]);
    expect(await refusalOf(put('Lose', [messageId(now)]))).toMatchObject({
      body: { code: 'ATTACHMENT_NOT_FOUND' },
    });
    expect(
      await db
        .selectFrom('attachments')
        .select('scheduled_message_id')
        .where('id', '=', file.id)
        .executeTakeFirst(),
    ).toEqual({ scheduled_message_id: id });
    const root = await atomically(
      async (tx) =>
        await sendMessage(tx, clock, alice.context, { id: messageId(now), content: 'Root' }),
    );
    const reply = await atomically(
      async (tx) =>
        await sendMessage(tx, clock, alice.context, {
          id: messageId(now),
          content: 'Reply',
          parentId: root.message.id,
        }),
    );
    expect(
      await refusalOf(
        atomically(
          async (tx) =>
            await scheduleMessage(tx, clock, alice.userId, room.channelId, id, {
              content: 'Too deep',
              sendAt,
              parentId: reply.message.id,
            }),
        ),
      ),
    ).toMatchObject({ body: { code: 'VALIDATION_FAILED' } });
    await atomically(async (tx) => {
      await cancelScheduledMessage(tx, alice.userId, room.channelId, id);
    });
  });

  test('replacement is one private draft, and only its owner can change or cancel it', async () => {
    const { db, room, alice, bob, id, put } = await setup();
    await put();
    expect((await put('Edited')).content).toBe('Edited');
    const context = await requireWorkspaceMembership(db, alice.userId, room.workspaceId);
    expect(await scheduledMessages(db, context)).toHaveLength(1);
    expect(
      await scheduledMessages(
        db,
        await requireWorkspaceMembership(db, bob.userId, room.workspaceId),
      ),
    ).toEqual([]);
    expect(
      await refusalOf(
        atomicallyOn(db)(async (tx) => {
          await cancelScheduledMessage(tx, bob.userId, room.channelId, id);
        }),
      ),
    ).toMatchObject({ body: { code: 'SCHEDULED_MESSAGE_NOT_FOUND' } });
    await atomicallyOn(db)(async (tx) => {
      await cancelScheduledMessage(tx, alice.userId, room.channelId, id);
    });
    expect(await scheduledMessages(db, context)).toEqual([]);
  });

  test('two delivery processes and a restart send once, at the due time, through normal realtime', async () => {
    const { db, room, id, put, dependencies, events } = await setup();
    await put();
    expect(await deliverScheduled({ ...dependencies, clock })).toBe(0);
    const counts = await Promise.all([
      deliverScheduled(dependencies),
      deliverScheduled(dependencies),
    ]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await deliverScheduled(dependencies)).toBe(0);
    const messages = await db
      .selectFrom('messages')
      .selectAll()
      .where('channel_id', '=', room.channelId)
      .execute();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).not.toBe(id);
    expect(messages[0]?.created_at.toISOString()).toBe(sendAt);
    expect(events.some((event) => event.event === 'MESSAGE_CREATED')).toBe(true);
    expect(await refusalOf(put())).toMatchObject({ body: { code: 'SCHEDULED_MESSAGE_SENT' } });
  });

  test('lost membership fails without a message; editing after rejoining retries it', async () => {
    const { db, room, alice, id, put, dependencies } = await setup();
    await put();
    await db
      .deleteFrom('channel_members')
      .where('channel_id', '=', room.channelId)
      .where('user_id', '=', alice.userId)
      .execute();
    expect(await deliverScheduled(dependencies)).toBe(0);
    expect(
      await db
        .selectFrom('scheduled_messages')
        .select(['state', 'failure_code'])
        .where('id', '=', id)
        .executeTakeFirst(),
    ).toEqual({ state: 'failed', failure_code: 'NOT_A_CHANNEL_MEMBER' });
    expect(
      await db
        .selectFrom('messages')
        .select('id')
        .where('channel_id', '=', room.channelId)
        .execute(),
    ).toEqual([]);
    await db
      .insertInto('channel_members')
      .values({ channel_id: room.channelId, user_id: alice.userId })
      .execute();
    await put('Retry');
    expect(await deliverScheduled(dependencies)).toBe(1);
  });

  test('reserved files survive orphan cleanup and cannot be discarded or sent elsewhere', async () => {
    const { db, room, alice, id, put, dependencies } = await setup();
    const storage = aMemoryStore();
    const atomically = atomicallyOn(db);
    const context = await requireWorkspaceMembership(db, alice.userId, room.workspaceId);
    const { attachment: file } = await storeUpload({ atomically, storage, log: NO_LOG }, context, {
      id: messageId(now),
      name: 'notes.txt',
      bytes: new Uint8Array([1, 2]),
    });
    await put('', [file.id]);
    await db
      .updateTable('attachments')
      .set({ created_at: new Date(now.getTime() - 2 * 86_400_000) })
      .where('id', '=', file.id)
      .execute();
    await sweepOrphans({ database: db, clock, storage, log: NO_LOG });
    expect(
      await db
        .selectFrom('attachments')
        .select('scheduled_message_id')
        .where('id', '=', file.id)
        .executeTakeFirst(),
    ).toEqual({ scheduled_message_id: id });
    expect(
      await refusalOf(discardUpload({ atomically, storage, log: NO_LOG }, alice.userId, file.id)),
    ).toMatchObject({ body: { code: 'ATTACHMENT_NOT_FOUND' } });
    expect(
      await refusalOf(
        atomically(
          async (tx) =>
            await sendMessage(tx, clock, alice.context, {
              id: messageId(now),
              content: '',
              attachmentIds: [file.id],
            }),
        ),
      ),
    ).toMatchObject({ body: { code: 'ATTACHMENT_NOT_FOUND' } });
    expect(await deliverScheduled(dependencies)).toBe(1);
    const attachment = await db
      .selectFrom('attachments')
      .select(['message_id', 'scheduled_message_id'])
      .where('id', '=', file.id)
      .executeTakeFirstOrThrow();
    expect(attachment.message_id).not.toBeNull();
    expect(attachment.scheduled_message_id).toBeNull();
  });

  test('invalid times, empty content and a root in another channel are refused', async () => {
    const { db, room, alice, id } = await setup();
    for (const input of [
      { content: 'Past', sendAt: now.toISOString() },
      { content: '', sendAt },
      { content: 'Too far', sendAt: '2030-01-01T00:00:00Z' },
    ]) {
      expect(
        await refusalOf(
          atomicallyOn(db)(
            async (tx) => await scheduleMessage(tx, clock, alice.userId, room.channelId, id, input),
          ),
        ),
      ).toMatchObject({ body: { code: 'VALIDATION_FAILED' } });
    }
    expect(
      await refusalOf(
        atomicallyOn(db)(
          async (tx) =>
            await scheduleMessage(tx, clock, alice.userId, room.channelId, id, {
              content: 'Reply',
              sendAt,
              parentId: messageId(now),
            }),
        ),
      ),
    ).toMatchObject({ body: { code: 'MESSAGE_NOT_FOUND' } });
  });
});
