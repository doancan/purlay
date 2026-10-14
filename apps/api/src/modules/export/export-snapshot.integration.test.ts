/**
 * An export is one snapshot (D-140): a row committed while it runs is in no file — on a cloned
 * database, because inside the harness's one transaction nothing commits beside it (D-46). The sink
 * that writes the messages' page commits a reaction from another connection before the reactions are
 * read; the export does not see it, so no reaction can name a message the export lacks, nor the
 * reverse.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, type ClonedDatabase } from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { snapshotOn } from '../../platform/transactions';
import { aRoom } from '../../testing/rooms';
import { sendMessage } from '../messages/messages';
import { exportWorkspace, readTables } from './export';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ObjectStore } from '../../platform/storage';
import { aMemoryStore } from '../../testing/storage';
import { aRecordingLogger } from '../../testing/doubles';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
});

afterAll(async () => {
  await cloned.drop();
});

const NOW = new Date('2026-10-14T12:00:00.000Z');

describe('integration: an export’s snapshot', () => {
  test('what commits while it reads is in no file', async () => {
    const room = await aRoom(cloned.db, ['ada', 'bob']);
    const ada = room.members['ada'];
    const bob = room.members['bob'];
    if (ada === undefined || bob === undefined) throw new Error('no people');
    const sent = await sendMessage(cloned.db, fixedClock(NOW), ada.context, {
      id: messageId(NOW),
      content: 'hello',
    });
    let committed = false;
    const reactions: string[] = [];
    await snapshotOn(cloned.db)(async (transaction) => {
      await readTables(
        transaction,
        { kind: 'all', workspaceId: room.workspaceId, channelIds: [room.channelId] },
        async (table, lines) => {
          if (table === 'messages' && !committed) {
            // Another connection, committed at once, while the export holds its snapshot.
            await cloned.db
              .insertInto('reactions')
              .values({ message_id: sent.message.id, user_id: bob.userId, emoji: '🎉' })
              .execute();
            committed = true;
          }
          if (table === 'reactions') reactions.push(...lines);
        },
      );
    });
    expect(committed).toBe(true);
    // The control: the reaction is there, for anybody reading now.
    expect(
      await cloned.db
        .selectFrom('reactions')
        .select('emoji')
        .where('message_id', '=', sent.message.id)
        .execute(),
    ).toEqual([{ emoji: '🎉' }]);
    expect(reactions).toEqual([]);
  });

  test('a file gone since the snapshot, its row gone too, is said removed — not a fault', async () => {
    const room = await aRoom(cloned.db, ['ada']);
    const ada = room.members['ada'];
    if (ada === undefined) throw new Error('no ada');
    const sent = await sendMessage(cloned.db, fixedClock(NOW), ada.context, {
      id: messageId(new Date(NOW.getTime() + 1)),
      content: 'with a file',
    });
    const fileId = messageId(new Date(NOW.getTime() + 2));
    const key = `${room.workspaceId}/${fileId}/original`;
    await cloned.db
      .insertInto('attachments')
      .values({
        id: fileId,
        workspace_id: room.workspaceId,
        channel_id: room.channelId,
        message_id: sent.message.id,
        uploader_id: ada.userId,
        storage_key: key,
        file_name: 'a.bin',
        mime_type: 'application/octet-stream',
        size_bytes: '1',
      })
      .execute();
    // The store is asked after the snapshot committed; by then a purge took the row and the object.
    const store = aMemoryStore();
    const removing: ObjectStore = {
      ...store,
      get: async (asked) => {
        if (asked === key) {
          await cloned.db.deleteFrom('attachments').where('id', '=', fileId).execute();
          return null;
        }
        return await store.get(asked);
      },
    };
    const target = join(await mkdtemp(join(tmpdir(), 'purlay-export-')), 'out');
    const { manifest } = await exportWorkspace(
      {
        database: cloned.db,
        clock: fixedClock(NOW),
        log: aRecordingLogger().log,
        storage: removing,
      },
      { id: room.workspaceId, slug: 'acme', name: 'Acme' },
      { kind: 'all', workspaceId: room.workspaceId, channelIds: [room.channelId] },
      target,
    );
    expect(manifest.blobs).toEqual({ count: 0, bytes: 0, removed: [fileId], missing: [] });
  });
});
