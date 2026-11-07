/**
 * `sweep:inbox` on a real database (D-286): a read notice goes after 30 days, every notice after 180, and one inside
 * both stays; a backlog larger than one batch is removed whole.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, type Transaction, withRollback } from '@purlay/db';
import { messageId } from '@purlay/types';
import { DAY_MS, fixedClock } from '../../platform/clock';
import { NOW } from '../../testing/doubles';
import { aUniqueSlug, aUserRow } from '../../testing/users';
import { INBOX_KEPT_DAYS, INBOX_READ_KEPT_DAYS, sweepInbox } from './sweep';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);

const aWorld = async (db: Transaction): Promise<{ workspaceId: string; userId: string }> => {
  const { userId } = await aUserRow(db, 'ada');
  const workspace = await db
    .insertInto('workspaces')
    .values({ name: 'Inbox', slug: aUniqueSlug('sweep') })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { workspaceId: workspace.id, userId };
};

let tick = 0;
const entry = async (
  db: Transaction,
  world: { workspaceId: string; userId: string },
  made: Date,
  read: Date | null,
): Promise<string> => {
  const id = messageId(new Date(made.getTime() + (tick += 1)));
  await db
    .insertInto('inbox_entries')
    .values({
      id,
      workspace_id: world.workspaceId,
      user_id: world.userId,
      module: 'issues',
      kind: 'issue_assigned',
      subject_type: 'issue',
      subject_id: crypto.randomUUID(),
      read_at: read,
      created_at: made,
    })
    .execute();
  return id;
};

const remaining = async (db: Transaction, userId: string): Promise<string[]> =>
  (await db.selectFrom('inbox_entries').select('id').where('user_id', '=', userId).execute()).map(
    (row) => row.id,
  );

describe('integration: sweep:inbox', () => {
  test('removes what was read over 30 days ago and what is over 180 days old, and keeps the rest', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const goneRead = await entry(db, world, daysAgo(40), daysAgo(INBOX_READ_KEPT_DAYS + 1));
      const goneOld = await entry(db, world, daysAgo(INBOX_KEPT_DAYS + 1), null);
      const goneOldRead = await entry(db, world, daysAgo(INBOX_KEPT_DAYS + 5), daysAgo(1));
      const keptRead = await entry(db, world, daysAgo(40), daysAgo(INBOX_READ_KEPT_DAYS - 1));
      const keptUnread = await entry(db, world, daysAgo(INBOX_KEPT_DAYS - 1), null);
      const keptNew = await entry(db, world, daysAgo(0), null);
      const { removed } = await sweepInbox({ database: db, clock: fixedClock(NOW) });
      const left = await remaining(db, world.userId);
      expect(left.sort()).toEqual([keptRead, keptUnread, keptNew].sort());
      expect(removed).toBe(3);
      expect([goneRead, goneOld, goneOldRead].some((id) => left.includes(id))).toBe(false);
    });
  });

  test('an empty table is nothing to do, and a second run removes nothing more', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await entry(db, world, daysAgo(INBOX_KEPT_DAYS + 1), null);
      expect((await sweepInbox({ database: db, clock: fixedClock(NOW) })).removed).toBeGreaterThan(
        0,
      );
      expect(await sweepInbox({ database: db, clock: fixedClock(NOW) })).toEqual({ removed: 0 });
    });
  });

  test('a backlog over one batch is removed whole', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const old = daysAgo(INBOX_KEPT_DAYS + 1);
      await db
        .insertInto('inbox_entries')
        .values(
          Array.from({ length: 2_500 }, (_, at) => ({
            id: messageId(new Date(old.getTime() + at)),
            workspace_id: world.workspaceId,
            user_id: world.userId,
            module: 'issues',
            kind: 'issue_assigned',
            subject_type: 'issue',
            subject_id: crypto.randomUUID(),
            created_at: old,
          })),
        )
        .execute();
      const kept = await entry(db, world, daysAgo(0), null);
      await sweepInbox({ database: db, clock: fixedClock(NOW) });
      expect(await remaining(db, world.userId)).toEqual([kept]);
    });
  });
});
