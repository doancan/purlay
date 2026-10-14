/**
 * Content erasure against the real database (D-27 §2, D-139 §7): every message the person wrote in the
 * workspace asked for is emptied, with what it named, pinned and was edited from, and their files go
 * with their objects and bytes — beside the controls: another person's message, an event nobody wrote,
 * and the same person's message in another workspace, all untouched. What it added is taken back; the
 * trail says what went; run again it finds nothing. And the command line: who, and where.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Transaction } from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { aRecordingLogger } from '../../testing/doubles';
import { aRoom, counters, type Room } from '../../testing/rooms';
import { aMemoryStore } from '../../testing/storage';
import { sendMessage } from '../messages/messages';
import { eraseContent, planContentErasure } from './content-erasure';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-10-14T12:00:00.000Z');
const clock = fixedClock(NOW);
let tick = 0;
const next = (): Date => new Date(NOW.getTime() + (tick += 1));

const member = (room: Room, name: string): NonNullable<Room['members'][string]> => {
  const found = room.members[name];
  if (found === undefined) throw new Error(`no member ${name}`);
  return found;
};

const say = async (db: Transaction, room: Room, as: string, content: string): Promise<string> => {
  const at = next();
  const sent = await sendMessage(db, fixedClock(at), member(room, as).context, {
    id: messageId(at),
    content,
  });
  return sent.message.id;
};

const message = async (
  db: Transaction,
  id: string,
): Promise<{ content: string; deleted: boolean }> => {
  const row = await db
    .selectFrom('messages')
    .select(['content', 'deleted_at'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return { content: row.content, deleted: row.deleted_at !== null };
};

describe('integration: erasing what a person wrote', () => {
  test('their words and files go in the workspace asked for; nobody else’s, and nowhere else', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['bob', 'ada']);
      const elsewhere = await aRoom(db, ['ada']);
      // ada, the same person in another workspace: her own row there.
      await db
        .updateTable('workspace_members')
        .set({ user_id: member(room, 'ada').userId })
        .where('workspace_id', '=', elsewhere.workspaceId)
        .execute();
      await db
        .updateTable('channel_members')
        .set({ user_id: member(room, 'ada').userId })
        .where('channel_id', '=', elsewhere.channelId)
        .execute();
      const ada = member(room, 'ada');
      const hers = await say(db, room, 'ada', `hi @${member(room, 'bob').username}`);
      const his = await say(db, room, 'bob', 'his own words');
      const eventAt = next();
      const event = messageId(eventAt);
      await db
        .insertInto('messages')
        .values({
          id: event,
          channel_id: room.channelId,
          workspace_id: room.workspaceId,
          sender_id: null,
          message_type: 'system_event',
          content: 'a push',
          created_at: eventAt,
        })
        .execute();
      const herElsewhere = await sendMessage(
        db,
        fixedClock(next()),
        { ...ada.context, channelId: elsewhere.channelId, workspaceId: elsewhere.workspaceId },
        { id: messageId(next()), content: 'kept elsewhere' },
      );
      const storage = aMemoryStore();
      const fileId = messageId(next());
      const key = `w/${room.workspaceId}/${fileId}`;
      await storage.put(key, new Uint8Array([1]), 'application/octet-stream');
      await db
        .insertInto('attachments')
        .values({
          id: fileId,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          message_id: hers,
          uploader_id: ada.userId,
          storage_key: key,
          file_name: 'ada.pdf',
          mime_type: 'application/pdf',
          size_bytes: '300',
        })
        .execute();
      await db
        .updateTable('workspaces')
        .set({ storage_used_bytes: '300' })
        .where('id', '=', room.workspaceId)
        .execute();
      expect(await counters(db, room, member(room, 'bob').userId)).toMatchObject({
        unread: 1,
        mentions: 1,
      });

      const done = await eraseContent(
        { database: db, clock, log: aRecordingLogger().log, storage },
        ada.userId,
        [room.workspaceId],
      );
      expect(done).toEqual([
        { workspaceId: room.workspaceId, messages: 1, files: 1, leftBehind: 0 },
      ]);
      expect(await message(db, hers)).toEqual({ content: '', deleted: true });
      // The controls.
      expect(await message(db, his)).toEqual({ content: 'his own words', deleted: false });
      expect(await message(db, event)).toEqual({ content: 'a push', deleted: false });
      expect(await message(db, herElsewhere.message.id)).toEqual({
        content: 'kept elsewhere',
        deleted: false,
      });
      // What it added, taken back; what it named, gone; its file and bytes, gone.
      expect(await counters(db, room, member(room, 'bob').userId)).toMatchObject({
        unread: 0,
        mentions: 0,
      });
      expect(
        await db
          .selectFrom('mentions')
          .select('message_id')
          .where('message_id', '=', hers)
          .execute(),
      ).toEqual([]);
      expect(storage.keys()).toEqual([]);
      expect(
        (
          await db
            .selectFrom('workspaces')
            .select('storage_used_bytes')
            .where('id', '=', room.workspaceId)
            .executeTakeFirstOrThrow()
        ).storage_used_bytes,
      ).toBe('0');
      expect(
        await db
          .selectFrom('audit_log')
          .select(['actor_user_id', 'target_id', 'metadata'])
          .where('workspace_id', '=', room.workspaceId)
          .where('action', '=', 'content.erased')
          .execute(),
      ).toEqual([
        { actor_user_id: null, target_id: ada.userId, metadata: { messages: '1', files: '1' } },
      ]);

      // Again: nothing left to erase, and the trail says that too.
      expect(
        await eraseContent(
          { database: db, clock, log: aRecordingLogger().log, storage },
          ada.userId,
          [room.workspaceId],
        ),
      ).toEqual([{ workspaceId: room.workspaceId, messages: 0, files: 0, leftBehind: 0 }]);
    });
  });

  test('a message they deleted already keeps no file either', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['bob', 'ada']);
      const ada = member(room, 'ada');
      const hers = await say(db, room, 'ada', 'gone soon');
      await db
        .updateTable('messages')
        .set({ deleted_at: NOW, content: '' })
        .where('id', '=', hers)
        .execute();
      const fileId = messageId(next());
      await db
        .insertInto('attachments')
        .values({
          id: fileId,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          message_id: hers,
          uploader_id: ada.userId,
          storage_key: `w/${room.workspaceId}/${fileId}`,
          file_name: 'a.bin',
          mime_type: 'application/octet-stream',
          size_bytes: '1',
        })
        .execute();
      expect(
        await eraseContent(
          { database: db, clock, log: aRecordingLogger().log, storage: aMemoryStore() },
          ada.userId,
          [room.workspaceId],
        ),
      ).toEqual([{ workspaceId: room.workspaceId, messages: 0, files: 1, leftBehind: 0 }]);
    });
  });

  test('the command line: who, by id, name or address, and where — or why not', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['bob', 'ada']);
      const ada = member(room, 'ada');
      await say(db, room, 'ada', 'words');
      const { slug } = await db
        .selectFrom('workspaces')
        .select('slug')
        .where('id', '=', room.workspaceId)
        .executeTakeFirstOrThrow();
      const { email } = await db
        .selectFrom('users')
        .select('email')
        .where('id', '=', ada.userId)
        .executeTakeFirstOrThrow();
      for (const who of [ada.userId, ada.username, email.toUpperCase()]) {
        expect(await planContentErasure(db, [who, '--workspace', slug])).toEqual({
          ok: true,
          userId: ada.userId,
          workspaceIds: [room.workspaceId],
        });
      }
      expect(await planContentErasure(db, [ada.username, '--all'])).toEqual({
        ok: true,
        userId: ada.userId,
        workspaceIds: [room.workspaceId],
      });
      for (const argv of [
        [],
        [ada.username],
        [ada.username, '--workspace'],
        [ada.username, '--all', slug],
        [ada.username, '--everything'],
      ]) {
        expect(await planContentErasure(db, argv)).toMatchObject({ ok: false });
      }
      expect(await planContentErasure(db, ['nobody-at-all', '--all'])).toEqual({
        ok: false,
        reason: 'nobody is known by that',
      });
      expect(await planContentErasure(db, [ada.username, '--workspace', 'no-such'])).toEqual({
        ok: false,
        reason: 'no workspace has that address',
      });
    });
  });
});
