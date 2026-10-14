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
import { cloneIntegrationDatabase, type ClonedDatabase } from '@purlay/db';
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
import { drainObjectDeletions, enqueueObjectDeletions, sweepObjectDeletions } from './deletions';
import { storeUpload } from './uploads';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
});

afterAll(async () => {
  await cloned.drop();
});

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
