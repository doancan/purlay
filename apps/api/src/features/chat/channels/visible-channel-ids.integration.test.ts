/**
 * The channels a person can see in one workspace (D-290): the same person belongs to two workspaces, and each one's
 * answer holds its own channels and none of the other's, read as ids and as the subquery lists embed.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { aRoom } from '../../../testing/rooms';
import { visibleChannelIds, visibleChannelIdsQuery } from './guard';

afterAll(async () => {
  await closeIntegrationDatabase();
});

describe('integration: the channels visible in one workspace', () => {
  test('are the workspace’s own, for a person who belongs to another workspace as well', async () => {
    await withRollback(async (db) => {
      const here = await aRoom(db, ['alice']);
      const there = await aRoom(db, ['owner']);
      const userId = here.members['alice']?.userId ?? '';
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: there.workspaceId, user_id: userId, role: 'member' })
        .execute();
      await db
        .insertInto('channel_members')
        .values({ channel_id: there.channelId, user_id: userId })
        .execute();
      const context = await requireWorkspaceMembership(db, userId, here.workspaceId);
      expect(await visibleChannelIds(db, context)).toEqual([here.channelId]);
      const embedded = await visibleChannelIdsQuery(db, context).execute();
      expect(embedded.map((row) => row.id)).toEqual([here.channelId]);
    });
  });
});
