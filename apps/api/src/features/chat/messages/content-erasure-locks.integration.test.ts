/**
 * Content erasure meeting a message another transaction holds (D-139 §7). The batch takes its
 * messages `SKIP LOCKED`, as the retention purge does — but a purge may leave a held row for the
 * next night, and an erasure the controller asked for may not report that it is done while words remain.
 * So a held message is counted and reported, the audit row says so, and a second run finishes the job.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type ClonedDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../../platform/clock';
import { atomicallyOn } from '../../../platform/transactions';
import { aRecordingLogger } from '../../../testing/doubles';
import { holdOpen } from '../../../testing/gates';
import { aRoom } from '../../../testing/rooms';
import { aMemoryStore } from '../../../testing/storage';
import { sendMessage } from './messages';
import { eraseContent } from './content-erasure';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const clock = fixedClock(NOW);

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

describe('integration: erasing a message another transaction holds', () => {
  test('it is counted and put on the trail, not passed over; the next run empties it', async () => {
    const db = cloned.db;
    const room = await aRoom(db, ['bob', 'ada']);
    const ada = room.members['ada'];
    if (ada === undefined) throw new Error('room');
    const say = async (at: Date, content: string): Promise<string> =>
      (await sendMessage(db, clock, ada.context, { id: messageId(at), content })).message.id;
    const free = await say(NOW, 'free to go');
    const kept = await say(new Date(NOW.getTime() + 10), 'still here');
    const held = holdOpen(atomicallyOn(db));
    const holder = held.atomically(async (transaction) => {
      await transaction
        .selectFrom('messages')
        .select('id')
        .where('id', '=', kept)
        .forUpdate()
        .execute();
    });
    await held.holding;
    const contentOf = async (id: string): Promise<string> =>
      (
        await db
          .selectFrom('messages')
          .select('content')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).content;

    const dependencies = {
      database: db,
      clock,
      log: aRecordingLogger().log,
      storage: aMemoryStore(),
    };
    const erase = async (): Promise<unknown> =>
      await eraseContent(dependencies, ada.userId, [room.workspaceId]);
    const done = (messages: number, lockedMessages: number): unknown => [
      { workspaceId: room.workspaceId, messages, files: 0, leftBehind: 0, lockedMessages },
    ];
    try {
      // One held among two: the other goes, the held one is counted.
      expect(await erase()).toEqual(done(1, 1));
      expect(await contentOf(free)).toBe('');
      expect(await contentOf(kept)).toBe('still here');
      expect(
        await db
          .selectFrom('audit_log')
          .select('metadata')
          .where('workspace_id', '=', room.workspaceId)
          .where('action', '=', 'content.erased')
          .execute(),
      ).toEqual([{ metadata: { messages: '1', files: '0', messagesLocked: '1' } }]);
      // Only the held one left: a batch that finds all of its candidates held says so too.
      expect(await erase()).toEqual(done(0, 1));
      expect(await contentOf(kept)).toBe('still here');
    } finally {
      // A failed expectation must not leave the row held: the clone cannot be dropped while it is.
      held.release();
      await holder;
    }
    expect(await erase()).toEqual(done(1, 0));
    expect(await contentOf(kept)).toBe('');
  });
});
