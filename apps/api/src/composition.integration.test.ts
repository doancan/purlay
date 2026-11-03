/**
 * The modules a process runs decide what the core's open places do, on a real database (D-250).
 *
 * With chat among them a new workspace starts with its channel and an erased account forgets what chat kept of it;
 * with no module the core does neither and nothing is the worse for it: the workspace exists, and the account's rows
 * that are chat's are left, inert, for the erasure and export of a module that is off to keep whole (D-250 rule 5).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { messageId } from '@purlay/types';
import { compose, composition } from './composition';
import { fixedClock } from './platform/clock';
import { aRoom } from './testing/rooms';
import { aUniqueSlug, aUserRow } from './testing/users';
import { createWorkspace } from './modules/workspaces/workspaces';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(new Date('2026-09-09T12:00:00.000Z'));

const channelsOf = async (
  db: Parameters<Parameters<typeof withRollback>[0]>[0],
  workspaceId: string,
): Promise<number> =>
  (await db.selectFrom('channels').select('id').where('workspace_id', '=', workspaceId).execute())
    .length;

describe('integration: what the modules a process runs make of the core’s open places', () => {
  test('a new workspace starts with chat’s channel when chat runs, and with none when no module does', async () => {
    await withRollback(async (db) => {
      const { userId: owner } = await aUserRow(db, 'ada');
      const withChat = await createWorkspace(
        db,
        clock,
        owner,
        { name: 'A', slug: aUniqueSlug('ws') },
        composition.workspaceCreated,
      );
      expect(await channelsOf(db, withChat.id)).toBe(1);

      const alone = compose([]);
      const without = await createWorkspace(
        db,
        clock,
        owner,
        { name: 'B', slug: aUniqueSlug('ws') },
        alone.workspaceCreated,
      );
      expect(await channelsOf(db, without.id)).toBe(0);
    });
  });

  test('an erased account forgets chat’s saved searches whether or not chat runs, and leaves them only in a build without it', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['pat']);
      const pat = room.members['pat'];
      if (pat === undefined) throw new Error('no pat');
      const save = async (name: string): Promise<void> => {
        await db
          .insertInto('saved_searches')
          .values({
            id: messageId(new Date()),
            workspace_id: room.workspaceId,
            user_id: pat.userId,
            name,
            query: JSON.stringify({ text: name }),
          })
          .execute();
      };
      const kept = async (): Promise<number> =>
        (
          await db
            .selectFrom('saved_searches')
            .select('id')
            .where('user_id', '=', pat.userId)
            .execute()
        ).length;

      await save('one');
      await compose([], []).userErased.run(db, pat.userId);
      expect(await kept()).toBe(1);
      await compose([]).userErased.run(db, pat.userId);
      expect(await kept()).toBe(0);
      await composition.userErased.run(db, pat.userId);
      expect(await kept()).toBe(0);
    });
  });
});
