/**
 * The parse at write time (`ARCHITECTURE.md` §8.1, D-101): what the stored row records about a
 * body, and that a body too complex to format is still a message.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { MARKDOWN_DELIMITERS_MAX } from '@purlay/markdown';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { aRoom, type Room } from '../../testing/rooms';
import { sendMessage, type Sent } from './messages';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);

const post = async (
  db: Executor,
  room: Room,
  content: string,
  id = messageId(NOW),
): Promise<Sent> => {
  const member = room.members['alice'];
  if (member === undefined) throw new Error('no member alice');
  return await sendMessage(db, clock, member.context, { id, content });
};

const stored = async (db: Executor, id: string): Promise<{ content: string; metadata: unknown }> =>
  await db
    .selectFrom('messages')
    .select(['content', 'metadata'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();

describe('integration: a message written', () => {
  test('records its code languages, whether it is only code, and its GitHub items', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const sent = await post(
        db,
        room,
        'Fixes https://github.com/purlay/purlay/issues/42\n\n```ts\nconst x = 1\n```\n\n```\nplain\n```',
      );
      expect((await stored(db, sent.message.id)).metadata).toEqual({
        codeLanguages: ['ts', ''],
        githubLinks: ['https://github.com/purlay/purlay/issues/42'],
      });
      expect(sent.unformatted).toBeNull();
    });
  });

  test('that is one fence is recorded as code only', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const sent = await post(db, room, '```sql\nselect 1\n```');
      expect((await stored(db, sent.message.id)).metadata).toEqual({
        codeLanguages: ['sql'],
        isCodeOnly: true,
      });
    });
  });

  test('with nothing to record records nothing', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const sent = await post(db, room, 'just *words*');
      expect((await stored(db, sent.message.id)).metadata).toEqual({});
    });
  });

  test('too complex to format is still sent and stored as typed, and records nothing', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const body = `https://github.com/o/r/pull/1 ${'*a'.repeat(MARKDOWN_DELIMITERS_MAX + 1)}`;
      const sent = await post(db, room, body);
      expect(sent.unformatted).toBe('delimiters');
      expect(await stored(db, sent.message.id)).toEqual({ content: body, metadata: {} });
    });
  });

  test('sent again under its id is answered from the row, and read no second time', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const id = messageId(NOW);
      await post(db, room, '```ts\na\n```', id);
      const again = await post(db, room, '```ts\na\n```', id);
      expect(again.unformatted).toBeNull();
      expect((await stored(db, id)).metadata).toEqual({ codeLanguages: ['ts'], isCodeOnly: true });
    });
  });
});
