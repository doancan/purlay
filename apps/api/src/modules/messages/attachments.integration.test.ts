/**
 * What a message carries (D-109 §6, §7): its attachments, read in one query for the whole page, in
 * the order they were uploaded — and none on a tombstone, which hides what was shown with the words.
 * Linking on send is the send's own test; here the rows are linked directly, so the reader is shown
 * alone.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import { requireMessageById } from '../../platform/channels';
import { fixedClock } from '../../platform/clock';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import { aRecordingLogger } from '../../testing/doubles';
import { twoColourPng } from '../../testing/png';
import { aRoom, type Room } from '../../testing/rooms';
import { aMemoryStore } from '../../testing/storage';
import { storeUpload } from '../attachments/uploads';
import { removeMessage } from './delete';
import { messageHistory, sendMessage } from './messages';
import { threadReplies } from './threads';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
let tick = 0;
const anId = (): string => messageId(new Date(NOW.getTime() - 60_000 + (tick += 1)));

const member = (room: Room, name: string): NonNullable<Room['members'][string]> => {
  const found = room.members[name];
  if (found === undefined) throw new Error(`no ${name}`);
  return found;
};

/** An upload of alice's, linked to the message as a send will link it. */
const attach = async (
  db: Executor,
  room: Room,
  to: string,
  name: string,
  bytes: Uint8Array = new Uint8Array(5).fill(7),
): Promise<string> => {
  const alice = member(room, 'alice');
  const context = await requireWorkspaceMembership(db, alice.userId, room.workspaceId);
  const id = anId();
  await storeUpload(
    { atomically: atomicallyOn(db), storage: aMemoryStore(), log: aRecordingLogger().log },
    context,
    { id, name, bytes },
  );
  await db.updateTable('attachments').set({ message_id: to }).where('id', '=', id).execute();
  return id;
};

describe('integration: a message’s attachments', () => {
  test('are on the message in upload order, measured; a message without any carries none', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = member(room, 'alice');
      const carrying = anId();
      const plain = anId();
      await sendMessage(db, clock, alice.context, { id: carrying, content: 'look' });
      await sendMessage(db, clock, alice.context, { id: plain, content: 'words only' });
      const first = await attach(db, room, carrying, 'shot.png', twoColourPng(40, 20));
      const second = await attach(db, room, carrying, 'notes.txt');

      const page = await messageHistory(db, alice.context);
      const byId = new Map(page.data.map((m) => [m.id, m]));
      expect(byId.get(carrying)?.attachments).toEqual([
        expect.objectContaining({ id: first, fileName: 'shot.png', kind: 'image', width: 40 }),
        expect.objectContaining({ id: second, fileName: 'notes.txt', kind: 'file', width: null }),
      ]);
      expect(byId.get(plain)?.attachments).toEqual([]);
    });
  });

  test('are read in one query for the page, wherever the page comes from: a thread too', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = member(room, 'alice');
      const root = anId();
      const reply = anId();
      await sendMessage(db, clock, alice.context, { id: root, content: 'root' });
      await sendMessage(db, clock, alice.context, { id: reply, content: 'reply', parentId: root });
      const id = await attach(db, room, reply, 'in-thread.txt');
      const target = await requireMessageById(db, alice.userId, root);
      const replies = await threadReplies(db, target);
      expect(replies.data.map((m) => m.attachments.map((a) => a.id))).toEqual([[id]]);
    });
  });

  test('are not shown on a tombstone, though the rows stay', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = member(room, 'alice');
      const root = anId();
      await sendMessage(db, clock, alice.context, { id: root, content: 'root' });
      await sendMessage(db, clock, alice.context, { id: anId(), content: 'r', parentId: root });
      await attach(db, room, root, 'secret.txt');
      await removeMessage(db, clock, alice.userId, root);
      const page = await messageHistory(db, alice.context);
      const tombstone = page.data.find((m) => m.id === root);
      expect(tombstone?.deletedAt).not.toBeNull();
      expect(tombstone?.attachments).toEqual([]);
      const kept = await db
        .selectFrom('attachments')
        .select('id')
        .where('message_id', '=', root)
        .execute();
      expect(kept).toHaveLength(1);
    });
  });
});
