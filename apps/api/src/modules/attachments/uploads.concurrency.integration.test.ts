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
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import type { ObjectStore } from '../../platform/storage';
import { atomicallyOn } from '../../platform/transactions';
import { aRecordingLogger } from '../../testing/doubles';
import { aRoom } from '../../testing/rooms';
import { aMemoryStore } from '../../testing/storage';
import { sendMessage } from '../messages/messages';
import { storeUpload } from './uploads';

const clock = fixedClock(new Date('2026-09-09T12:00:00.000Z'));

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

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

describe('integration: sending an upload, at once', () => {
  const later = (n: number): string => messageId(new Date(Date.UTC(2026, 8, 9, 11, 59, 0, n)));
  const uploadFor = async (
    room: Awaited<ReturnType<typeof aRoom>>,
    id: string,
    bytes: number,
  ): Promise<void> => {
    const alice = room.members['alice'];
    if (alice === undefined) throw new Error('room');
    const context = await requireWorkspaceMembership(cloned.db, alice.userId, room.workspaceId);
    await storeUpload(
      { atomically: atomicallyOn(cloned.db), storage: aMemoryStore(), log: aRecordingLogger().log },
      context,
      { id, name: `${id}.txt`, bytes: new Uint8Array(bytes).fill(1) },
    );
  };

  test('two messages carrying one upload: one has it, the other is refused and not written', async () => {
    const db = cloned.db;
    const room = await aRoom(db, ['alice']);
    const alice = room.members['alice'];
    if (alice === undefined) throw new Error('room');
    const upload = later(1);
    await uploadFor(room, upload, 5);
    const sending = (id: string): Promise<string> =>
      atomicallyOn(db)(
        async (transaction) =>
          await sendMessage(transaction, clock, alice.context, {
            id,
            content: 'mine',
            attachmentIds: [upload],
          }),
      ).then(
        () => 'sent',
        (error: unknown) => (error instanceof AppError ? error.body.code : String(error)),
      );
    const [a, b] = [later(2), later(3)];
    const outcomes = await Promise.all([sending(a), sending(b)]);
    expect([...outcomes].sort()).toEqual(['ATTACHMENT_NOT_FOUND', 'sent']);
    const written = await db
      .selectFrom('messages')
      .select('id')
      .where('id', 'in', [a, b])
      .execute();
    expect(written).toHaveLength(1);
    const workspace = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', room.workspaceId)
      .executeTakeFirstOrThrow();
    expect(Number(workspace.storage_used_bytes)).toBe(5);
  });

  test('an upload and a send in one workspace at once both finish, and the bytes are counted once', async () => {
    const db = cloned.db;
    const room = await aRoom(db, ['alice']);
    const alice = room.members['alice'];
    if (alice === undefined) throw new Error('room');
    const sent = later(4);
    const fresh = later(6);
    await uploadFor(room, sent, 5);
    await Promise.all([
      atomicallyOn(db)(
        async (transaction) =>
          await sendMessage(transaction, clock, alice.context, {
            id: later(5),
            content: 'here',
            attachmentIds: [sent],
          }),
      ),
      uploadFor(room, fresh, 7),
    ]);
    const workspace = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', room.workspaceId)
      .executeTakeFirstOrThrow();
    expect(Number(workspace.storage_used_bytes)).toBe(5);
    const waiting = await db
      .selectFrom('attachments')
      .select('id')
      .where('workspace_id', '=', room.workspaceId)
      .where('message_id', 'is', null)
      .execute();
    expect(waiting.map((row) => row.id)).toEqual([fresh]);
  });
});
