/**
 * An edit and a delete of one message at once (D-135 §4): whichever takes the row first, no version
 * is left behind — an edit first keeps one and the delete then removes it; a delete first leaves the
 * edit nothing to edit. Never a deleted message whose old words are still in its history.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type ClonedDatabase,
  CLONE_HOOK_MS,
} from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { aRoom } from '../../testing/rooms';
import { removeMessage } from './delete';
import { reviseMessage } from './edit';
import { sendMessage } from './messages';

const clock = fixedClock(new Date('2026-10-14T12:00:00.000Z'));

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
});

const outcome = async (work: Promise<unknown>): Promise<string> =>
  await work.then(
    () => 'done',
    (error: unknown) => (error instanceof AppError ? error.body.code : String(error)),
  );

describe('integration: an edit and a delete at once', () => {
  test('whichever is first, the deleted message keeps no earlier words', async () => {
    const db = cloned.db;
    for (let round = 0; round < 5; round += 1) {
      const room = await aRoom(db, ['alice']);
      const alice = room.members['alice'];
      if (alice === undefined) throw new Error('no alice');
      const sent = await db.transaction().execute(
        async (t) =>
          await sendMessage(t, clock, alice.context, {
            id: messageId(clock.now()),
            content: 'a secret',
          }),
      );
      const id = sent.message.id;
      const [edited, deleted] = await Promise.all([
        outcome(
          db
            .transaction()
            .execute(async (t) => await reviseMessage(t, clock, alice.userId, id, 'gone')),
        ),
        outcome(
          db.transaction().execute(async (t) => await removeMessage(t, clock, alice.userId, id)),
        ),
      ]);
      expect(deleted).toBe('done');
      expect(['done', 'MESSAGE_NOT_FOUND']).toContain(edited);
      const left = await db
        .selectFrom('message_versions')
        .select('id')
        .where('message_id', '=', id)
        .execute();
      expect({ round, edited, left: left.length }).toEqual({ round, edited, left: 0 });
    }
  });
});
