/**
 * What a new workspace is made with, and that it is made whole or not at all (D-174, D-250).
 *
 * The first channel is chat's, registered as a hook the workspace code runs in its own transaction; these
 * tests are what keeps that move from changing what a person gets.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  withRollback,
  type ClonedDatabase,
} from '@purlay/db';
import { DEFAULT_CHANNEL_NAME } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { hookList } from '../../platform/hooks';
import { atomicallyOn } from '../../platform/transactions';
import { aUniqueSlug, aUserRow } from '../../testing/users';
import { chatWorkspaceHooks } from '../channels/workspace-hooks';
import { createWorkspace, type WorkspaceCreated } from './workspaces';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);

afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

const clock = fixedClock(new Date('2026-09-09T12:00:00.000Z'));

describe('integration: a new workspace and its first channel', () => {
  test('is made with one channel named for the default, its owner in it, and on the trail', async () => {
    await withRollback(async (db) => {
      const { userId: owner } = await aUserRow(db, 'ada');
      const workspace = await createWorkspace(
        db,
        clock,
        owner,
        { name: 'Ada', slug: aUniqueSlug('ws') },
        chatWorkspaceHooks(),
      );
      const channels = await db
        .selectFrom('channels')
        .select(['id', 'name', 'created_by'])
        .where('workspace_id', '=', workspace.id)
        .execute();
      expect(channels.map((c) => [c.name, c.created_by])).toEqual([[DEFAULT_CHANNEL_NAME, owner]]);
      const members = await db
        .selectFrom('channel_members')
        .select('user_id')
        .where('channel_id', '=', channels[0]?.id ?? '')
        .execute();
      expect(members.map((m) => m.user_id)).toEqual([owner]);
      const trail = await db
        .selectFrom('audit_log')
        .select('action')
        .where('workspace_id', '=', workspace.id)
        .orderBy('id')
        .execute();
      expect(trail.map((row) => row.action)).toContain('channel.created');
    });
  });

  test('a hook that throws takes the workspace, its owner and what the earlier hooks made with it', async () => {
    const { userId: owner } = await aUserRow(cloned.db, 'bob');
    const hooks = chatWorkspaceHooks();
    hooks.register(() => Promise.reject(new Error('a module could not start')));
    const slug = aUniqueSlug('ws');
    // A real transaction: what is committed or rolled back is the thing under test.
    const outcome = await atomicallyOn(cloned.db)(
      async (transaction) =>
        await createWorkspace(transaction, clock, owner, { name: 'Bob', slug }, hooks),
    ).then(
      () => 'made',
      (error: unknown) => String(error),
    );
    expect(outcome).toContain('a module could not start');
    const workspaces = await cloned.db
      .selectFrom('workspaces')
      .select('id')
      .where('slug', '=', slug)
      .execute();
    expect(workspaces).toEqual([]);
    const members = await cloned.db
      .selectFrom('workspace_members')
      .select('user_id')
      .where('user_id', '=', owner)
      .execute();
    expect(members).toEqual([]);
  });

  test('with no hook registered the workspace has no channel: the core makes none of its own', async () => {
    await withRollback(async (db) => {
      const { userId: owner } = await aUserRow(db, 'cy');
      const workspace = await createWorkspace(
        db,
        clock,
        owner,
        { name: 'Cy', slug: aUniqueSlug('ws') },
        hookList<Parameters<WorkspaceCreated['run']>>(),
      );
      const channels = await db
        .selectFrom('channels')
        .select('id')
        .where('workspace_id', '=', workspace.id)
        .execute();
      expect(channels).toEqual([]);
    });
  });
});
