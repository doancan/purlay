/**
 * Channel visibility, against a real database.
 *
 * The rule is written whole even though Phase 0 creates only public channels: a
 * guard correct for the case that exists today stops being a guard the day the
 * next one arrives, and here that means showing somebody a conversation they were
 * not in. So the private cases are seeded directly and tested now.
 *
 * Every refusal must be the same refusal (D-34).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { AppError } from './errors';
import { requireChannelById, requireChannelVisibility, visibleChannelIds } from './channels';
import { requireWorkspaceMembership } from './tenancy';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const addUser = async (db: Executor, name: string): Promise<string> => {
  const row = await db
    .insertInto('users')
    .values({ email: `${name}@example.test`, username: name, display_name: name })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
};

const addWorkspace = async (db: Executor, slug: string, ...members: string[]): Promise<string> => {
  const row = await db
    .insertInto('workspaces')
    .values({ name: slug, slug })
    .returning('id')
    .executeTakeFirstOrThrow();
  for (const userId of members) {
    await db
      .insertInto('workspace_members')
      .values({ workspace_id: row.id, user_id: userId })
      .execute();
  }
  return row.id;
};

const addChannel = async (
  db: Executor,
  workspaceId: string,
  name: string,
  type: 'public' | 'private' = 'public',
  ...members: string[]
): Promise<string> => {
  const row = await db
    .insertInto('channels')
    .values({ workspace_id: workspaceId, name, type })
    .returning('id')
    .executeTakeFirstOrThrow();
  for (const userId of members) {
    await db
      .insertInto('channel_members')
      .values({ channel_id: row.id, user_id: userId })
      .execute();
  }
  return row.id;
};

const refusalFrom = async (body: () => Promise<unknown>): Promise<AppError> => {
  try {
    await body();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('the guard returned a context where it was required to refuse');
};

describe('integration: channel visibility', () => {
  test('a public channel is visible to any member of its workspace', async () => {
    await withRollback(async (db) => {
      const userId = await addUser(db, 'ch-member');
      const workspaceId = await addWorkspace(db, 'ch-open', userId);
      const channelId = await addChannel(db, workspaceId, 'general');
      const workspace = await requireWorkspaceMembership(db, userId, workspaceId);

      const context = await requireChannelVisibility(db, workspace, channelId);
      expect(context.channelId).toBe(channelId);
      expect(context.channelType).toBe('public');
      expect(context.workspaceId).toBe(workspaceId);
    });
  });

  /**
   * The second axis. A member of the workspace is not automatically a member of
   * every conversation inside it — the case D-34 exists for.
   */
  test('a private channel is invisible to a workspace member who is not in it', async () => {
    await withRollback(async (db) => {
      const insider = await addUser(db, 'ch-inside');
      const outsider = await addUser(db, 'ch-outside');
      const workspaceId = await addWorkspace(db, 'ch-private', insider, outsider);
      const channelId = await addChannel(db, workspaceId, 'secret', 'private', insider);

      const forInsider = await requireWorkspaceMembership(db, insider, workspaceId);
      expect((await requireChannelVisibility(db, forInsider, channelId)).channelType).toBe(
        'private',
      );

      const forOutsider = await requireWorkspaceMembership(db, outsider, workspaceId);
      const refusal = await refusalFrom(() => requireChannelVisibility(db, forOutsider, channelId));
      expect(refusal.status).toBe(404);
      expect(refusal.body.code).toBe('CHANNEL_NOT_FOUND');
    });
  });

  test('every refusal is the same refusal, so none of them is an oracle', async () => {
    await withRollback(async (db) => {
      const insider = await addUser(db, 'ch-oracle-in');
      const outsider = await addUser(db, 'ch-oracle-out');
      const theirs = await addWorkspace(db, 'ch-theirs', insider);
      const mine = await addWorkspace(db, 'ch-mine', outsider);
      const hidden = await addChannel(db, theirs, 'theirs');
      const deleted = await addChannel(db, mine, 'gone');
      await db
        .updateTable('channels')
        .set({ deleted_at: new Date('2026-01-01T00:00:00.000Z') })
        .where('id', '=', deleted)
        .execute();

      const context = await requireWorkspaceMembership(db, outsider, mine);
      const answers = [
        // in another workspace
        await refusalFrom(() => requireChannelVisibility(db, context, hidden)),
        // soft-deleted
        await refusalFrom(() => requireChannelVisibility(db, context, deleted)),
        // never existed
        await refusalFrom(() =>
          requireChannelVisibility(db, context, '00000000-0000-4000-8000-000000000000'),
        ),
        // not even a uuid — must not become a 500 on the cast
        await refusalFrom(() =>
          requireChannelVisibility(db, context, "'; DROP TABLE channels; --"),
        ),
      ];

      const shapes = new Set(answers.map((answer) => JSON.stringify(answer.response)));
      expect(shapes.size).toBe(1);
      expect(answers.every((answer) => answer.status === 404)).toBe(true);
    });
  });

  test('addressing a channel directly still verifies workspace membership first', async () => {
    await withRollback(async (db) => {
      const insider = await addUser(db, 'ch-direct-in');
      const stranger = await addUser(db, 'ch-direct-out');
      const workspaceId = await addWorkspace(db, 'ch-direct', insider);
      const channelId = await addChannel(db, workspaceId, 'general');

      expect((await requireChannelById(db, insider, channelId)).channelId).toBe(channelId);

      // The stranger belongs to no workspace at all: the answer must not differ
      // from the one for a channel that does not exist.
      const refusal = await refusalFrom(() => requireChannelById(db, stranger, channelId));
      const missing = await refusalFrom(() =>
        requireChannelById(db, stranger, '00000000-0000-4000-8000-000000000000'),
      );
      expect(refusal.status).toBe(404);
      expect(JSON.stringify(refusal.response)).toBe(JSON.stringify(missing.response));
    });
  });

  test('the visible set is what a workspace-wide read narrows with', async () => {
    await withRollback(async (db) => {
      const alice = await addUser(db, 'ch-set-a');
      const bob = await addUser(db, 'ch-set-b');
      const workspaceId = await addWorkspace(db, 'ch-set', alice, bob);
      const open = await addChannel(db, workspaceId, 'general');
      const hers = await addChannel(db, workspaceId, 'alice-only', 'private', alice);
      const gone = await addChannel(db, workspaceId, 'archived');
      await db
        .updateTable('channels')
        .set({ deleted_at: new Date('2026-01-01T00:00:00.000Z') })
        .where('id', '=', gone)
        .execute();

      const forAlice = await requireWorkspaceMembership(db, alice, workspaceId);
      const forBob = await requireWorkspaceMembership(db, bob, workspaceId);

      expect([...(await visibleChannelIds(db, forAlice))].sort()).toEqual([open, hers].sort());
      expect(await visibleChannelIds(db, forBob)).toEqual([open]);
    });
  });
});
