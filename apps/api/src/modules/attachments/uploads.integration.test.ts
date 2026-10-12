/**
 * Storing an upload (D-109 §3, §5): the object and its row, an idempotent retry, the bounds on what
 * one person and one workspace may hold, and what is left behind when anything refuses — nothing.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { PENDING_UPLOADS_MAX, messageId } from '@purlay/types';
import { AppError } from '../../platform/errors';
import { aRecordingLogger } from '../../testing/doubles';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import { aRoom, type Room } from '../../testing/rooms';
import { aMemoryStore, type MemoryStore } from '../../testing/storage';
import { storeUpload } from './uploads';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);
let tick = 0;
const anId = (): string => messageId(new Date(NOW + (tick += 1)));

const who = (room: Room, name: string): string => {
  const found = room.members[name] ?? room.outsiders[name];
  if (found === undefined) throw new Error(`no ${name}`);
  return found.userId;
};

const upload = async (
  db: Executor,
  store: MemoryStore,
  room: Room,
  as: string,
  input: { id?: string; name?: string; bytes?: number },
  log = aRecordingLogger().log,
): ReturnType<typeof storeUpload> => {
  const context = await requireWorkspaceMembership(db, who(room, as), room.workspaceId);
  return await storeUpload({ atomically: atomicallyOn(db), storage: store, log }, context, {
    id: input.id ?? anId(),
    name: input.name ?? 'notes.txt',
    bytes: new Uint8Array(input.bytes ?? 5).fill(7),
  });
};

const refusalOf = async (attempt: Promise<unknown>): Promise<string> => {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof AppError) return error.body.code;
    throw error;
  }
  throw new Error('accepted where it had to be refused');
};

const quota = async (db: Executor, room: Room, bytes: number, used = 0): Promise<void> => {
  await db
    .updateTable('workspaces')
    .set({ storage_quota_bytes: String(bytes), storage_used_bytes: String(used) })
    .where('id', '=', room.workspaceId)
    .execute();
};

describe('integration: an upload', () => {
  test('is an object and a row, unattached, answered as the contract says', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const store = aMemoryStore();
      const id = anId();
      const { attachment, created } = await upload(db, store, room, 'alice', { id, bytes: 5 });
      expect(created).toBe(true);
      expect(attachment).toEqual({
        id,
        fileName: 'notes.txt',
        mimeType: 'application/octet-stream',
        sizeBytes: 5,
        kind: 'file',
        width: null,
        height: null,
      });
      const row = await db
        .selectFrom('attachments')
        .select(['message_id', 'storage_key', 'uploader_id'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(row.message_id).toBeNull();
      expect(row.uploader_id).toBe(who(room, 'alice'));
      expect(store.keys()).toEqual([row.storage_key]);
      expect(row.storage_key.startsWith(`w/${room.workspaceId}/`)).toBe(true);
    });
  });

  test('the same upload again answers the attachment it made, and stores nothing new', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const store = aMemoryStore();
      const id = anId();
      await upload(db, store, room, 'alice', { id });
      const again = await upload(db, store, room, 'alice', { id });
      expect(again.created).toBe(false);
      expect(store.keys()).toHaveLength(1);
    });
  });

  test('an id somebody else used is a conflict, and their file is untouched', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const store = aMemoryStore();
      const id = anId();
      await upload(db, store, room, 'alice', { id });
      const before = store.keys();
      expect(await refusalOf(upload(db, store, room, 'bob', { id }))).toBe(
        'ATTACHMENT_ID_CONFLICT',
      );
      // The same person with other bytes under the same id is a conflict too, not an overwrite.
      expect(await refusalOf(upload(db, store, room, 'alice', { id, bytes: 9 }))).toBe(
        'ATTACHMENT_ID_CONFLICT',
      );
      expect(store.keys()).toEqual(before);
    });
  });

  test('an id that is not a UUIDv7 is refused by name', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const store = aMemoryStore();
      const refusal = await refusalOf(
        upload(db, store, room, 'alice', { id: '00000000-0000-4000-8000-000000000001' }),
      );
      expect(refusal).toBe('VALIDATION_FAILED');
      expect(store.keys()).toEqual([]);
    });
  });
});

describe('integration: the bounds', () => {
  test('a person may hold so many unattached uploads, and the next leaves nothing behind', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const store = aMemoryStore();
      for (let n = 0; n < PENDING_UPLOADS_MAX; n += 1) await upload(db, store, room, 'alice', {});
      expect(await refusalOf(upload(db, store, room, 'alice', {}))).toBe(
        'TOO_MANY_PENDING_UPLOADS',
      );
      expect(store.keys()).toHaveLength(PENDING_UPLOADS_MAX);
      // Somebody else's count is their own.
      expect((await upload(db, store, room, 'bob', {})).created).toBe(true);
    });
  });

  test('the quota counts what is stored and what is waiting: at it taken, one byte over refused', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const store = aMemoryStore();
      await quota(db, room, 100, 60);
      await upload(db, store, room, 'alice', { bytes: 30 });
      // 60 stored + 30 waiting + 10 = the quota exactly.
      await upload(db, store, room, 'alice', { bytes: 10 });
      expect(await refusalOf(upload(db, store, room, 'alice', { bytes: 1 }))).toBe(
        'STORAGE_QUOTA_EXCEEDED',
      );
      expect(store.keys()).toHaveLength(2);
    });
  });
});

describe('integration: when the store refuses', () => {
  test('a write that fails stores no row', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const store = aMemoryStore();
      store.failing('put', new Error('the bucket is down'));
      const id = anId();
      let thrown = '';
      await upload(db, store, room, 'alice', { id }).catch((error: unknown) => {
        thrown = error instanceof Error ? error.message : '';
      });
      expect(thrown).toBe('the bucket is down');
      const row = await db.selectFrom('attachments').select('id').where('id', '=', id).execute();
      expect(row).toEqual([]);
    });
  });

  test('a refused upload whose object cannot be deleted says so, loudly, naming the key', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const store = aMemoryStore();
      await quota(db, room, 4);
      store.failing('delete', new Error('cannot delete'));
      const { log, lines } = aRecordingLogger();
      expect(await refusalOf(upload(db, store, room, 'alice', { bytes: 5 }, log))).toBe(
        'STORAGE_QUOTA_EXCEEDED',
      );
      const line = lines.find((l) => l['msg'] === 'an upload’s object was left behind');
      expect(line?.['level']).toBe('error');
      expect(String(line?.['key'])).toContain(`w/${room.workspaceId}/`);
    });
  });
});
