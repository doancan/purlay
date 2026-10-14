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
import { readTables } from './export';

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
});
