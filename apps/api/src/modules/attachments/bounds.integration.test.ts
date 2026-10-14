/**
 * The attachment bounds are the database's (migration 0018, D-109 §2): the contract's constants
 * are bound to the CHECKs by inserting at each bound and one past it, so neither can move alone.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  ATTACHMENT_BYTES_MAX,
  ATTACHMENT_PIXELS_MAX,
  ATTACHMENT_SIDE_MAX,
  messageId,
} from '@purlay/types';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { inSavepoint } from '../../testing/attempt';

afterAll(async () => {
  await closeIntegrationDatabase();
});

let tick = 0;

/** A workspace and a person in it, enough to own an attachment. */
const owner = async (db: Executor): Promise<{ workspaceId: string; userId: string }> => {
  tick += 1;
  const user = await db
    .insertInto('users')
    .values({
      username: `att-${String(tick)}`,
      display_name: 'A',
      email: `att-${String(tick)}@x.test`,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const workspace = await db
    .insertInto('workspaces')
    .values({ name: 'A', slug: `att-${String(tick)}-${String(Date.now())}` })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { workspaceId: workspace.id, userId: user.id };
};

/** Whether the database takes an attachment with these numbers. */
const takes = async (
  db: Executor,
  numbers: { size?: number; width?: number | null; height?: number | null },
): Promise<boolean> => {
  const { workspaceId, userId } = await owner(db);
  const id = messageId(new Date(Date.UTC(2026, 8, 9, 12, 0, 0) + (tick += 1)));
  // Each attempt in a savepoint: a refused insert must not end the test's transaction.
  const outcome = await inSavepoint(db, async () => {
    await db
      .insertInto('attachments')
      .values({
        id,
        workspace_id: workspaceId,
        uploader_id: userId,
        storage_key: `w/${workspaceId}/${id}`,
        file_name: 'a.bin',
        mime_type: 'application/octet-stream',
        size_bytes: String(numbers.size ?? 1),
        width: numbers.width ?? null,
        height: numbers.height ?? null,
      })
      .execute();
  });
  if (outcome.taken) return true;
  const { error } = outcome;
  if (error instanceof Error && error.message.includes('violates check constraint')) return false;
  throw error;
};

describe('integration: the attachment bounds are the database’s', () => {
  test('the size: at the limit taken, one past it and zero refused', async () => {
    await withRollback(async (db) => {
      expect(await takes(db, { size: ATTACHMENT_BYTES_MAX })).toBe(true);
      expect(await takes(db, { size: ATTACHMENT_BYTES_MAX + 1 })).toBe(false);
      expect(await takes(db, { size: 0 })).toBe(false);
    });
  });

  test('a side: at the limit taken, one past it refused; both sides or neither', async () => {
    await withRollback(async (db) => {
      expect(await takes(db, { width: ATTACHMENT_SIDE_MAX, height: 1 })).toBe(true);
      expect(await takes(db, { width: ATTACHMENT_SIDE_MAX + 1, height: 1 })).toBe(false);
      expect(await takes(db, { width: 10, height: null })).toBe(false);
    });
  });

  test('the pixels: at the limit taken, one row past it refused', async () => {
    await withRollback(async (db) => {
      const side = 10_000;
      const rows = ATTACHMENT_PIXELS_MAX / side;
      expect(await takes(db, { width: side, height: rows })).toBe(true);
      expect(await takes(db, { width: side, height: rows + 1 })).toBe(false);
    });
  });
});
