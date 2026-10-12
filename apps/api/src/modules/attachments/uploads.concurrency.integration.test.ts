/**
 * Two attempts at one attachment id at once, on two real connections (D-109 §3, §5): the
 * workspace row's lock makes them take turns, so the second finds the first's row and deletes only
 * its own object. Both are held at the store until both have looked, so the outcome is the lock's.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type ClonedDatabase,
} from '@purlay/db';
import { messageId } from '@purlay/types';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import type { ObjectStore } from '../../platform/storage';
import { atomicallyOn } from '../../platform/transactions';
import { aRecordingLogger } from '../../testing/doubles';
import { aRoom } from '../../testing/rooms';
import { aMemoryStore } from '../../testing/storage';
import { storeUpload } from './uploads';

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
});
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
});

describe('integration: two attempts at one id at once', () => {
  test('leave one row and one object', async () => {
    const db = cloned.db;
    const room = await aRoom(db, ['alice']);
    const alice = room.members['alice'];
    if (alice === undefined) throw new Error('room');
    const context = await requireWorkspaceMembership(db, alice.userId, room.workspaceId);
    const store = aMemoryStore();
    // Neither writes until both have looked for the id and found nothing.
    let arrived = 0;
    let bothHere: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      bothHere = resolve;
    });
    const held: ObjectStore = {
      ...store,
      put: async (key, bytes, type): Promise<void> => {
        arrived += 1;
        if (arrived === 2) bothHere();
        await barrier;
        await store.put(key, bytes, type);
      },
    };
    const deps = { atomically: atomicallyOn(db), storage: held, log: aRecordingLogger().log };
    const id = messageId(new Date('2026-09-09T12:00:00.000Z'));
    const input = { id, name: 'notes.txt', bytes: new Uint8Array(5).fill(7) };

    const [a, b] = await Promise.all([
      storeUpload(deps, context, input),
      storeUpload(deps, context, input),
    ]);

    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.attachment).toEqual(b.attachment);
    const row = await db
      .selectFrom('attachments')
      .select('storage_key')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(store.keys()).toEqual([row.storage_key]);
  });
});
