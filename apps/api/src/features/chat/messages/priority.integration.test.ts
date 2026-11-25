/**
 * How much a message asks of the people it is for (#1381): `normal`, `important` or `urgent`, allowed only where there is
 * somebody to ask it of (a direct message, or a body that names a person) so it can never page a channel.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../../platform/clock';
import { aRoom, type Room } from '../../../testing/rooms';
import { AppError } from '../../../platform/errors';
import { sendMessage, type OutgoingMessage, type Sent } from './messages';
import { readBuilt } from './reader';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
let tick = 0;
const nextId = (): string => messageId(new Date(NOW.getTime() + (tick += 1) * 10));

const post = async (
  db: Executor,
  room: Room,
  as: string,
  content: string,
  extra: Partial<OutgoingMessage> = {},
): Promise<Sent> => {
  const member = room.members[as];
  if (member === undefined) throw new Error(`no member ${as}`);
  return await sendMessage(db, clock, member.context, { id: nextId(), content, ...extra });
};

/** The code a send was refused with, or `accepted`, and the fields it named. */
const refusal = async (attempt: Promise<unknown>): Promise<{ code: string; fields: string[] }> =>
  await attempt.then(
    () => ({ code: 'accepted', fields: [] }),
    (error: unknown) =>
      error instanceof AppError
        ? {
            code: error.body.code,
            fields:
              error.body.code === 'VALIDATION_FAILED' ? Object.keys(error.body.details.fields) : [],
          }
        : { code: String(error), fields: [] },
  );

const at = (room: Room, name: string): string => `@${room.members[name]?.username ?? ''}`;

describe('integration: a message that asks more of its recipient', () => {
  test('in a direct message, urgent is kept and read back with the message', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob'], { type: 'direct_message' });
      const sent = await post(db, room, 'alice', 'the release is blocked on you', {
        priority: 'urgent',
      });
      expect(sent.message.priority).toBe('urgent');
      expect((await readBuilt(db, sent.message.id))?.priority).toBe('urgent');
    });
  });

  test('in a channel, naming somebody is enough, and important is kept', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const sent = await post(db, room, 'alice', `${at(room, 'bob')} please look`, {
        priority: 'important',
      });
      expect(sent.message.priority).toBe('important');
    });
  });

  test('a normal message says nothing of priority, and so does one that names it normal', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const plain = await post(db, room, 'alice', 'hello');
      const named = await post(db, room, 'alice', 'hello again', { priority: 'normal' });
      expect('priority' in plain.message).toBe(false);
      expect('priority' in named.message).toBe(false);
    });
  });

  test('in a channel with nobody named, it is refused', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      expect(
        await refusal(post(db, room, 'alice', 'everyone look', { priority: 'urgent' })),
      ).toEqual({ code: 'VALIDATION_FAILED', fields: ['priority'] });
    });
  });

  test('a name that resolves to nobody is not somebody', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      expect(
        await refusal(post(db, room, 'alice', '@nobodyhere look', { priority: 'important' })),
      ).toEqual({ code: 'VALIDATION_FAILED', fields: ['priority'] });
    });
  });

  test('a person who cannot see a private channel is not somebody named in it', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob'], { type: 'private' });
      expect(
        await refusal(post(db, room, 'alice', '@outsider look', { priority: 'urgent' })),
      ).toEqual({ code: 'VALIDATION_FAILED', fields: ['priority'] });
    });
  });

  test('a reply carries it under the same rule', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const root = await post(db, room, 'alice', 'a question');
      expect(
        await refusal(
          post(db, room, 'bob', 'urgent answer', { parentId: root.message.id, priority: 'urgent' }),
        ),
      ).toEqual({ code: 'VALIDATION_FAILED', fields: ['priority'] });
      const named = await post(db, room, 'bob', `${at(room, 'alice')} urgent answer`, {
        parentId: root.message.id,
        priority: 'urgent',
      });
      expect(named.message.priority).toBe('urgent');
    });
  });

  test('a retry returns the message as first written, priority and all', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob'], { type: 'direct_message' });
      const id = nextId();
      const member = room.members['alice'];
      if (member === undefined) throw new Error('no alice');
      const first = await sendMessage(db, clock, member.context, {
        id,
        content: 'now',
        priority: 'urgent',
      });
      const again = await sendMessage(db, clock, member.context, { id, content: 'now' });
      expect(again.message).toEqual(first.message);
    });
  });

  test('a deleted one no longer says it was urgent', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob'], { type: 'direct_message' });
      const sent = await post(db, room, 'alice', 'now', { priority: 'urgent' });
      await db
        .updateTable('messages')
        .set({ deleted_at: NOW })
        .where('id', '=', sent.message.id)
        .execute();
      expect((await readBuilt(db, sent.message.id))?.priority).toBeUndefined();
    });
  });

  test('the database refuses a value it does not know', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const sent = await post(db, room, 'alice', 'hello');
      const outcome = await db
        .updateTable('messages')
        .set({ priority: 'critical' })
        .where('id', '=', sent.message.id)
        .execute()
        .then(
          () => 'accepted',
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
      expect(outcome).toContain('messages_priority_known');
    });
  });
});
