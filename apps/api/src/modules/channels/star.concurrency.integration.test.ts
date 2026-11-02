/**
 * One star asked for twice at once (D-132): the row changes once, and the second is told it did
 * not, so the person's tabs are told once. The decision and the write are one statement; the
 * second waits on the first's row and finds it already starred.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type ClonedDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { aRoom } from '../../testing/rooms';
import { setStarred } from './star';

const clock = fixedClock(new Date('2026-10-14T12:00:00.000Z'));

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

describe('integration: two stars at once', () => {
  test('one changes the row, the other finds it changed', async () => {
    const db = cloned.db;
    const room = await aRoom(db, ['alice']);
    const context = room.members['alice']?.context;
    if (context === undefined) throw new Error('no alice');
    const changed = await Promise.all([
      db.transaction().execute(async (t) => await setStarred(t, clock, context, true)),
      db.transaction().execute(async (t) => await setStarred(t, clock, context, true)),
    ]);
    expect([...changed].sort()).toEqual([false, true]);
  });
});
