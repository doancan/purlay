/**
 * Objects whose rows are gone, until the store lets them go (#592, D-141), on a cloned database — what
 * is asserted is what commits and what rolls back, which the harness's one transaction cannot show
 * (D-46).
 *
 * Queued with the rows' delete, never apart from it: a delete that fails takes its queue rows with it.
 * Drained after the commit: what the store accepts leaves the queue, what it refuses stays, counted.
 * A process that stopped before the delete leaves the key for the sweep. And the sweep goes on past
 * keys the store keeps refusing, to the ones after them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  type ClonedDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { createLogger } from '../../platform/logging';
import type { ObjectStore } from '../../platform/storage';
import { workspacePrefix } from '../../platform/storage';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import { NOW } from '../../testing/doubles';
import { aRoom, type Room } from '../../testing/rooms';
import { aMemoryStore, type MemoryStore } from '../../testing/storage';
import { sendMessage } from '../messages/messages';
import { dropFiles } from '../messages/tombstone';
import {
  drainObjectDeletions,
  enqueueObjectDeletions,
  sweepObjectDeletions,
  writeUploadKeysAhead,
} from './deletions';
import { storeUpload } from './uploads';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);

afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

const clock = fixedClock(NOW);
const silent = createLogger({ level: 'silent' });
let tick = 0;
const anId = (): string => messageId(new Date(NOW.getTime() + (tick += 1)));

/** A message of ada's carrying one file, its object in the store; answers the message and its key. */
const aFile = async (
  store: MemoryStore,
): Promise<{ readonly room: Room; readonly message: string; readonly key: string }> => {
  const room = await aRoom(cloned.db, ['ada']);
  const ada = room.members['ada'];
  if (ada === undefined) throw new Error('no ada');
  const fileId = anId();
  await storeUpload(
    { atomically: atomicallyOn(cloned.db), storage: store, log: silent },
    await requireWorkspaceMembership(cloned.db, ada.userId, room.workspaceId),
    { id: fileId, name: 'notes.txt', bytes: new Uint8Array(4).fill(1) },
  );
  const sent = await sendMessage(cloned.db, clock, ada.context, {
    id: anId(),
    content: 'with a file',
    attachmentIds: [fileId],
  });
  const [key] = store.keys().filter((each) => each.startsWith(workspacePrefix(room.workspaceId)));
  if (key === undefined) throw new Error('no object');
  return { room, message: sent.message.id, key };
};

const queued = async (room: Room): Promise<{ storage_key: string; attempts: number }[]> =>
  await cloned.db
    .selectFrom('object_deletions')
    .select(['storage_key', 'attempts'])
    .where('storage_key', 'like', `${workspacePrefix(room.workspaceId)}%`)
    .orderBy('storage_key')
    .execute();

const drain = (store: ObjectStore): Parameters<typeof drainObjectDeletions>[0] => ({
  atomically: atomicallyOn(cloned.db),
  storage: store,
  log: silent,
});

describe('integration: objects whose rows are gone', () => {
  test('a delete that fails after its files were queued takes the queue rows back with it', async () => {
    const store = aMemoryStore();
    const { room, message, key } = await aFile(store);
    const failed = await atomicallyOn(cloned.db)(async (transaction) => {
      await dropFiles(transaction, room.workspaceId, [message]);
      throw new Error('the rest of the batch failed');
    }).then(
      () => 'committed',
      (error: unknown) => String(error),
    );
    expect(failed).toContain('the rest of the batch failed');
    expect(await queued(room)).toEqual([]);
    expect(
      await cloned.db
        .selectFrom('attachments')
        .select('storage_key')
        .where('workspace_id', '=', room.workspaceId)
        .execute(),
    ).toEqual([{ storage_key: key }]);
  });

  test('queued with the rows’ delete; refused, it stays, counted; the sweep takes it later', async () => {
    const store = aMemoryStore();
    const { room, message, key } = await aFile(store);
    const keys = await atomicallyOn(cloned.db)(
      async (transaction) => (await dropFiles(transaction, room.workspaceId, [message])).keys,
    );
    expect(keys).toEqual([key]);
    // Committed: the row is gone, and its object waits by name.
    expect(await queued(room)).toEqual([{ storage_key: key, attempts: 0 }]);
    store.failing('delete', new Error('the bucket refuses'), 0);
    expect(await drainObjectDeletions(drain(store), keys)).toBe(1);
    expect(await drainObjectDeletions(drain(store), keys)).toBe(1);
    expect(await queued(room)).toEqual([{ storage_key: key, attempts: 2 }]);
    expect(store.keys()).toEqual([key]);

    const accepting = aMemoryStore();
    const swept = await sweepObjectDeletions({ ...drain(accepting), database: cloned.db });
    expect(swept.removed).toBeGreaterThanOrEqual(1);
    expect(await queued(room)).toEqual([]);
  });

  test('a process that stopped between the commit and the delete: the sweep finds the key', async () => {
    const store = aMemoryStore();
    const { room, message, key } = await aFile(store);
    await atomicallyOn(cloned.db)(async (transaction) => {
      await dropFiles(transaction, room.workspaceId, [message]);
    });
    // No drain: the process stopped here.
    expect(store.keys()).toEqual([key]);
    await sweepObjectDeletions({ ...drain(store), database: cloned.db });
    expect(store.keys()).toEqual([]);
    expect(await queued(room)).toEqual([]);
  });

  test('keys the store keeps refusing never hold back the ones after them', async () => {
    const room = await aRoom(cloned.db, ['ada']);
    const prefix = workspacePrefix(room.workspaceId);
    // More refused keys than one batch reads, and two the store accepts after them.
    const refused = Array.from(
      { length: 501 },
      (_, at) => `${prefix}a/${String(at).padStart(4, '0')}`,
    );
    const accepted = [`${prefix}b/1`, `${prefix}b/2`];
    await atomicallyOn(cloned.db)(async (transaction) => {
      await enqueueObjectDeletions(transaction, [...refused, ...accepted]);
      // Queued twice, kept once.
      await enqueueObjectDeletions(transaction, accepted);
    });
    const memory = aMemoryStore();
    const store: ObjectStore = {
      ...memory,
      delete: async (key): Promise<void> => {
        if (key.startsWith(`${prefix}a/`)) throw new Error('refused');
        await memory.delete(key);
      },
    };
    const outcome = await sweepObjectDeletions({ ...drain(store), database: cloned.db }).then(
      () => 'swept',
      (error: unknown) => String(error),
    );
    expect(outcome).toContain('501 object(s) could not be deleted from storage');
    const left = await queued(room);
    expect(left.map((row) => row.storage_key)).toEqual(refused);
    expect(left.every((row) => row.attempts === 1)).toBe(true);
    await cloned.db
      .deleteFrom('object_deletions')
      .where('storage_key', 'like', `${prefix}%`)
      .execute();
  });

  test('a key outside every workspace is refused by the table itself', async () => {
    const outcome = await atomicallyOn(cloned.db)(async (transaction) => {
      await enqueueObjectDeletions(transaction, ['elsewhere/key']);
    }).then(
      () => 'queued',
      (error: unknown) => String(error),
    );
    expect(outcome).toContain('object_deletions_key_in_a_workspace');
  });
});

describe('integration: an upload’s objects are named before they exist (#607)', () => {
  test('its keys wait in the queue while its object is written, and the row’s insert takes them back', async () => {
    const memory = aMemoryStore();
    const room = await aRoom(cloned.db, ['ada']);
    const ada = room.members['ada'];
    if (ada === undefined) throw new Error('no ada');
    const queuedWhilePut: boolean[] = [];
    const store: ObjectStore = {
      ...memory,
      put: async (key, bytes, type): Promise<void> => {
        const row = await cloned.db
          .selectFrom('object_deletions')
          .select('storage_key')
          .where('storage_key', '=', key)
          .executeTakeFirst();
        queuedWhilePut.push(row !== undefined);
        await memory.put(key, bytes, type);
      },
    };
    await storeUpload(
      { atomically: atomicallyOn(cloned.db), storage: store, log: silent },
      await requireWorkspaceMembership(cloned.db, ada.userId, room.workspaceId),
      { id: anId(), name: 'notes.txt', bytes: new Uint8Array(4).fill(1) },
    );
    expect(queuedWhilePut).toEqual([true]);
    expect(await queued(room)).toEqual([]);
    expect(memory.keys()).toHaveLength(1);
  });

  test('a stop between the write and the insert: the sweep takes the object once its grace has passed', async () => {
    const store = aMemoryStore();
    const room = await aRoom(cloned.db, ['ada']);
    const key = `${workspacePrefix(room.workspaceId)}${anId()}/orphan`;
    await atomicallyOn(cloned.db)(async (transaction) => {
      await writeUploadKeysAhead(transaction, [key]);
    });
    await store.put(key, new Uint8Array([1]), 'application/octet-stream');
    // The process stopped here: no row, and the upload may still have been on its way.
    await sweepObjectDeletions({ ...drain(store), database: cloned.db });
    expect(store.keys()).toEqual([key]);
    await cloned.db
      .updateTable('object_deletions')
      .set({ due_at: new Date(NOW.getTime() - 60_000) })
      .where('storage_key', '=', key)
      .execute();
    await sweepObjectDeletions({ ...drain(store), database: cloned.db });
    expect(store.keys()).toEqual([]);
    expect(await queued(room)).toEqual([]);
  });

  test('an upload refused lets its objects go at once, and leaves nothing queued', async () => {
    const store = aMemoryStore();
    const room = await aRoom(cloned.db, ['ada']);
    const ada = room.members['ada'];
    if (ada === undefined) throw new Error('no ada');
    await cloned.db
      .updateTable('workspaces')
      .set({ storage_quota_bytes: '1' })
      .where('id', '=', room.workspaceId)
      .execute();
    const refused = await storeUpload(
      { atomically: atomicallyOn(cloned.db), storage: store, log: silent },
      await requireWorkspaceMembership(cloned.db, ada.userId, room.workspaceId),
      { id: anId(), name: 'big.txt', bytes: new Uint8Array(4).fill(1) },
    ).then(
      () => 'stored',
      (error: unknown) => String(error),
    );
    expect(refused).toContain('no room');
    expect(store.keys()).toEqual([]);
    expect(await queued(room)).toEqual([]);
  });
});
