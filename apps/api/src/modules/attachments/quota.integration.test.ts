/**
 * A workspace's storage against its quota (D-173): what the owner is shown is what the upload check
 * counts, and the operator's command reads and sets the quota.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import { AppError } from '../../platform/errors';
import { aRecordingLogger } from '../../testing/doubles';
import { requireWorkspaceMembership, type WorkspaceContext } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import { aRoom, type Room } from '../../testing/rooms';
import { aMemoryStore } from '../../testing/storage';
import { operateQuota, readStorage } from './quota';
import { storeUpload } from './uploads';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
let tick = 0;

const contextOf = async (db: Executor, room: Room, name: string): Promise<WorkspaceContext> => {
  const member = room.members[name];
  if (member === undefined) throw new Error(`no ${name}`);
  return await requireWorkspaceMembership(db, member.userId, room.workspaceId);
};

const setQuota = async (db: Executor, room: Room, quota: number, used: number): Promise<void> => {
  await db
    .updateTable('workspaces')
    .set({ storage_quota_bytes: String(quota), storage_used_bytes: String(used) })
    .where('id', '=', room.workspaceId)
    .execute();
};

const upload = async (db: Executor, room: Room, bytes: number): Promise<unknown> =>
  await storeUpload(
    { atomically: atomicallyOn(db), storage: aMemoryStore(), log: aRecordingLogger().log },
    await contextOf(db, room, 'alice'),
    {
      id: messageId(new Date(NOW + (tick += 1))),
      name: 'notes.txt',
      bytes: new Uint8Array(bytes).fill(7),
    },
  );

const slugOf = async (db: Executor, room: Room): Promise<string> =>
  (
    await db
      .selectFrom('workspaces')
      .select('slug')
      .where('id', '=', room.workspaceId)
      .executeTakeFirstOrThrow()
  ).slug;

describe('integration: a workspace’s storage, as its owner is shown it', () => {
  test('counts what is kept and what waits to be sent, and agrees with the room a refused upload names', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await setQuota(db, room, 100, 60);
      await upload(db, room, 30);
      const shown = await readStorage(db, await contextOf(db, room, 'alice'));
      expect(shown).toEqual({ usedBytes: 90, quotaBytes: 100 });

      let remaining: unknown;
      await upload(db, room, 11).catch((error: unknown) => {
        if (error instanceof AppError && 'details' in error.body) remaining = error.body.details;
      });
      expect(remaining).toEqual({ remainingBytes: shown.quotaBytes - shown.usedBytes });
    });
  });

  test('is an owner’s: a member is refused for what they are', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      let refused = '';
      await readStorage(db, await contextOf(db, room, 'bob')).catch((error: unknown) => {
        if (error instanceof AppError) refused = error.body.code;
      });
      expect(refused).toBe('FORBIDDEN');
    });
  });
});

describe('integration: the operator’s quota command', () => {
  test('reads the storage, sets a new quota the next upload is checked against, and knows no other slug', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      await setQuota(db, room, 1000, 40);
      const slug = await slugOf(db, room);
      expect(await operateQuota(db, slug, null)).toEqual({
        workspaceId: room.workspaceId,
        quotaBytes: 1000n,
        usedBytes: 40n,
      });
      expect(await operateQuota(db, slug, 50n)).toEqual({
        workspaceId: room.workspaceId,
        quotaBytes: 50n,
        usedBytes: 40n,
      });
      expect((await readStorage(db, await contextOf(db, room, 'alice'))).quotaBytes).toBe(50);
      let refused = '';
      await upload(db, room, 11).catch((error: unknown) => {
        if (error instanceof AppError) refused = error.body.code;
      });
      expect(refused).toBe('STORAGE_QUOTA_EXCEEDED');
      expect(await operateQuota(db, `${slug}-nobody`, 10n)).toBeNull();
    });
  });

  test('a deleted workspace is not one to set', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const slug = await slugOf(db, room);
      await db
        .updateTable('workspaces')
        .set({ deleted_at: new Date(NOW) })
        .where('id', '=', room.workspaceId)
        .execute();
      expect(await operateQuota(db, slug, 10n)).toBeNull();
    });
  });
});
