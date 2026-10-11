/**
 * The parse at write time (`ARCHITECTURE.md` §8.1, D-101): what the stored row records about a
 * body, and that a body too complex to format is still a message.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { MARKDOWN_DELIMITERS_MAX, type Engine } from '@purlay/markdown';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import type { EventBus } from '../../platform/events';
import { atomicallyOn } from '../../platform/transactions';
import { aRecordingLogger } from '../../testing/doubles';
import { aRoom, notificationsOf, type Room } from '../../testing/rooms';
import { send, sendMessage, type Sent } from './messages';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);

const idOf = (room: Room, name: string): string => {
  const member = room.members[name];
  if (member === undefined) throw new Error(`no member ${name}`);
  return member.context.userId;
};

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
      const tooComplex = '*a'.repeat(MARKDOWN_DELIMITERS_MAX + 1);
      // The first call read it and said why it is not formatted; a re-read would say so again.
      expect((await post(db, room, tooComplex, id)).unformatted).toBe('delimiters');
      expect((await post(db, room, tooComplex, id)).unformatted).toBeNull();
      // A retry carrying other content changes nothing that was recorded.
      await post(db, room, '```ts\na\n```', id);
      expect(await stored(db, id)).toEqual({ content: tooComplex, metadata: {} });
    });
  });
});

describe('integration: who a message names, read where the reader sees prose', () => {
  /** A mention of a member by the username the room gave them: `@bob` names nobody real. */
  const mention = (room: Room, name: string): string => `@${room.members[name]?.username ?? name}`;

  test.each([
    ['a tilde fence', (at: string): string => `~~~\n${at}\n~~~`],
    ['a fence inside a list item', (at: string): string => `- step\n\n  \`\`\`\n  ${at}\n  \`\`\``],
  ])('a name inside %s, which renders as code, tells nobody', async (_, wrap) => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await post(db, room, wrap(mention(room, 'bob')));
      expect(await notificationsOf(db, idOf(room, 'bob'))).toEqual([]);
    });
  });

  test('the same name in prose does tell them: the test above could have failed', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await post(db, room, `${mention(room, 'bob')} have a look`);
      expect(await notificationsOf(db, idOf(room, 'bob'))).toHaveLength(1);
    });
  });

  test('a body too complex to format still tells the person it names', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const sent = await post(
        db,
        room,
        `${mention(room, 'bob')} ${'*a'.repeat(MARKDOWN_DELIMITERS_MAX + 1)}`,
      );
      expect(sent.unformatted).toBe('delimiters');
      expect(await notificationsOf(db, idOf(room, 'bob'))).toHaveLength(1);
    });
  });
});

describe('integration: the engine failing inside its bounds', () => {
  const quiet: EventBus = {
    publish: () => Promise.resolve(),
    subscribe: () => false,
    unsubscribe: () => undefined,
    forget: () => undefined,
  };

  test('is stored and shown as typed, and logged as an error with its cause and not the body', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = room.members['alice'];
      if (alice === undefined) throw new Error('room');
      const fails = (): never => {
        throw new RangeError('Maximum call stack size exceeded');
      };
      const engine: Engine = { blocks: () => ({ type: 'root', children: [] }), full: fails };
      const { log, lines } = aRecordingLogger();
      const body = 'a secret plan in **bold**';
      const dependencies = { atomically: atomicallyOn(db), clock, bus: quiet, log, engine };
      const answer = await send(dependencies, alice.context, { id: messageId(NOW), content: body });
      expect(await stored(db, answer.id)).toEqual({ content: body, metadata: {} });
      const failures = lines.filter(
        (line) => line['msg'] === 'markdown engine failed inside its bounds',
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        level: 'error',
        messageId: answer.id,
        length: body.length,
      });
      expect(JSON.stringify(failures[0])).toContain('Maximum call stack size exceeded');
      expect(JSON.stringify(lines)).not.toContain('secret plan');
    });
  });
});
