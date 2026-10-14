/**
 * A message's earlier versions (#82, D-135): each edit keeps what it replaced, at the edit's own
 * instant; the same words again keep nothing; the history is read by anybody who can read the
 * message, newest first, a page at a time, and keeps the latest `MESSAGE_VERSIONS_KEPT`; the author
 * removes one; deleting the message removes them all.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { MESSAGE_CONTENT_MAX, MESSAGE_VERSIONS_KEPT, PAGE_LIMIT, messageId } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { aRoom, type Room } from '../../testing/rooms';
import { removeMessage } from './delete';
import { reviseMessage } from './edit';
import { sendMessage } from './messages';
import { messageVersions, removeVersion } from './versions';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-10-14T12:00:00.000Z');
const at = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1000);

const idOf = (room: Room, name: string): string => {
  const member = room.members[name] ?? room.outsiders[name];
  if (member === undefined) throw new Error(`no ${name}`);
  return member.userId;
};

const refusal = async (work: Promise<unknown>): Promise<string> =>
  await work.then(
    () => 'done',
    (error: unknown) => (error instanceof AppError ? error.body.code : String(error)),
  );

const written = async (db: Executor, room: Room, content = 'first'): Promise<string> => {
  const alice = room.members['alice']?.context;
  if (alice === undefined) throw new Error('no alice');
  const sent = await sendMessage(db, fixedClock(NOW), alice, { id: messageId(NOW), content });
  return sent.message.id;
};

const edit = async (
  db: Executor,
  room: Room,
  message: string,
  content: string,
  when: Date,
): Promise<void> => {
  await reviseMessage(db, fixedClock(when), idOf(room, 'alice'), message, content);
};

const stored = async (db: Executor, message: string): Promise<number> =>
  (await db.selectFrom('message_versions').select('id').where('message_id', '=', message).execute())
    .length;

describe('integration: a message’s earlier versions', () => {
  test('each edit keeps what it replaced, at its own instant; newest first', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const message = await written(db, room);
      await edit(db, room, message, 'second', at(10));
      await edit(db, room, message, 'third', at(20));
      const page = await messageVersions(db, idOf(room, 'bob'), message, {});
      expect(page.data.map((v) => [v.content, v.replacedAt])).toEqual([
        ['second', at(20).toISOString()],
        ['first', at(10).toISOString()],
      ]);
      expect(page.nextCursor).toBeNull();
      // The message's own edit time is the instant its last version was replaced.
      const row = await db
        .selectFrom('messages')
        .select(['content', 'edited_at'])
        .where('id', '=', message)
        .executeTakeFirstOrThrow();
      expect([row.content, row.edited_at]).toEqual(['third', at(20)]);
    });
  });

  test('edits on one instant, or a clock stepped back, still list in the order they were made', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const message = await written(db, room, 'one');
      await edit(db, room, message, 'two', at(10));
      await edit(db, room, message, 'three', at(10));
      await edit(db, room, message, 'four', at(5));
      const page = await messageVersions(db, idOf(room, 'alice'), message, {});
      expect(page.data.map((v) => v.content)).toEqual(['three', 'two', 'one']);
    });
  });

  test('an edit refused for what it says keeps nothing', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const message = await written(db, room);
      expect(
        await refusal(
          reviseMessage(db, fixedClock(at(1)), idOf(room, 'alice'), message, '@here look'),
        ),
      ).toBe('VALIDATION_FAILED');
      expect(await stored(db, message)).toBe(0);
    });
  });

  test('the same words again keep nothing; going back to earlier words keeps both changes', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const message = await written(db, room, 'A');
      await edit(db, room, message, 'A', at(5));
      expect(await stored(db, message)).toBe(0);
      await edit(db, room, message, 'B', at(10));
      await edit(db, room, message, 'A', at(20));
      const page = await messageVersions(db, idOf(room, 'alice'), message, {});
      expect(page.data.map((v) => v.content)).toEqual(['B', 'A']);
    });
  });

  test('read a page at a time, the latest first, the cursor a version’s id', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const message = await written(db, room, 'v0');
      for (let n = 1; n <= 5; n++) await edit(db, room, message, `v${String(n)}`, at(n));
      const alice = idOf(room, 'alice');
      const first = await messageVersions(db, alice, message, { limit: 2 });
      expect(first.data.map((v) => v.content)).toEqual(['v4', 'v3']);
      const second = await messageVersions(db, alice, message, {
        limit: 2,
        ...(first.nextCursor === null ? {} : { before: first.nextCursor }),
      });
      expect(second.data.map((v) => v.content)).toEqual(['v2', 'v1']);
      const all = await messageVersions(db, alice, message, { limit: PAGE_LIMIT.max });
      expect(all.data).toHaveLength(5);
      expect(all.nextCursor).toBeNull();
      // Exactly a page: nothing past it, so no cursor to an empty page.
      const exact = await messageVersions(db, alice, message, { limit: 5 });
      expect([exact.data.length, exact.nextCursor]).toEqual([5, null]);
    });
  });

  test(`keeps the latest ${String(MESSAGE_VERSIONS_KEPT)}: one more edit lets the oldest go`, async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const message = await written(db, room, 'e0');
      for (let n = 1; n <= MESSAGE_VERSIONS_KEPT; n++) {
        await edit(db, room, message, `e${String(n)}`, at(n));
      }
      expect(await stored(db, message)).toBe(MESSAGE_VERSIONS_KEPT);
      await edit(db, room, message, 'one more', at(MESSAGE_VERSIONS_KEPT + 1));
      expect(await stored(db, message)).toBe(MESSAGE_VERSIONS_KEPT);
      const oldest = await db
        .selectFrom('message_versions')
        .select('content')
        .where('message_id', '=', message)
        .orderBy('id')
        .executeTakeFirstOrThrow();
      expect(oldest.content).toBe('e1');
    });
  });

  test('a version is as long as a message may be, and the table refuses one longer', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const longest = 'x'.repeat(MESSAGE_CONTENT_MAX);
      const message = await written(db, room, longest);
      await edit(db, room, message, 'short', at(1));
      const [version] = (await messageVersions(db, idOf(room, 'alice'), message, {})).data;
      expect(version?.content).toHaveLength(MESSAGE_CONTENT_MAX);
    });
    let outcome = 'not tried';
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const message = await written(db, room);
      outcome = await db
        .insertInto('message_versions')
        .values({
          id: messageId(NOW),
          message_id: message,
          channel_id: room.channelId,
          workspace_id: room.workspaceId,
          content: 'x'.repeat(MESSAGE_CONTENT_MAX + 1),
          replaced_at: NOW,
        })
        .execute()
        .then(
          () => 'written',
          (error: unknown) => (error instanceof Error ? error.message : 'not an error'),
        );
    });
    expect(outcome).toContain('message_versions_content_length');
  });

  test('somebody who cannot read the message cannot read its history: not found', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice'], { type: 'private', outsiders: ['carol'] });
      const message = await written(db, room);
      await edit(db, room, message, 'second', at(1));
      expect(await refusal(messageVersions(db, idOf(room, 'carol'), message, {}))).toBe(
        'MESSAGE_NOT_FOUND',
      );
      expect(await refusal(messageVersions(db, idOf(room, 'alice'), 'not-a-uuid', {}))).toBe(
        'MESSAGE_NOT_FOUND',
      );
    });
  });

  test('deleting the message removes its history with its words', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const message = await written(db, room, 'a secret');
      await edit(db, room, message, 'nothing to see', at(1));
      expect(await stored(db, message)).toBe(1);
      await removeMessage(db, fixedClock(at(2)), idOf(room, 'alice'), message);
      expect(await stored(db, message)).toBe(0);
      expect(await refusal(messageVersions(db, idOf(room, 'alice'), message, {}))).toBe(
        'MESSAGE_NOT_FOUND',
      );
    });
  });

  test('the author removes one version; nobody else may; a version not this message’s is not found', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const message = await written(db, room, 'token ghp_oops');
      await edit(db, room, message, 'token removed', at(1));
      await edit(db, room, message, 'token removed, sorry', at(2));
      const [newest, oldest] = (await messageVersions(db, idOf(room, 'alice'), message, {})).data;
      if (newest === undefined || oldest === undefined) throw new Error('no versions');

      expect(await refusal(removeVersion(db, idOf(room, 'bob'), message, oldest.id))).toBe(
        'FORBIDDEN',
      );
      const other = await written(db, room, 'another');
      expect(await refusal(removeVersion(db, idOf(room, 'alice'), other, oldest.id))).toBe(
        'MESSAGE_VERSION_NOT_FOUND',
      );
      expect(await refusal(removeVersion(db, idOf(room, 'alice'), message, 'nope'))).toBe(
        'MESSAGE_VERSION_NOT_FOUND',
      );

      await removeVersion(db, idOf(room, 'alice'), message, oldest.id);
      const left = (await messageVersions(db, idOf(room, 'bob'), message, {})).data;
      expect(left.map((v) => v.content)).toEqual(['token removed']);
      // Gone already is the same answer as never there.
      expect(await refusal(removeVersion(db, idOf(room, 'alice'), message, oldest.id))).toBe(
        'MESSAGE_VERSION_NOT_FOUND',
      );
    });
  });
});
