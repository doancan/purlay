/** A guest can discover people only through their currently shared conversations. */
import { afterAll, describe, expect, test } from 'bun:test';
import { withRollback, closeIntegrationDatabase } from '@purlay/db';
import { aRoom } from '../../../testing/rooms';
import { attempt } from '../../../testing/attempt';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { membersIn } from '../../../modules/workspaces/workspaces';
import { chatWorkspaceChannels } from './workspace-channels';
import { channelMembers } from './settings';
import { requireChannelById } from './guard';
import { withinRequest } from '../../../platform/logging';
import { effectiveModules } from '../../../platform/module-kit/entitlement';

afterAll(async () => {
  await closeIntegrationDatabase();
});

describe('integration: guest directory', () => {
  test('shared people require current scope in this workspace, even if active somewhere else', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'guest', 'expired', 'suspended'], {
        outsiders: ['unshared'],
      });
      const now = new Date();
      const guestId = room.members['guest']?.userId ?? '';
      const expiredId = room.members['expired']?.userId ?? '';
      const suspendedId = room.members['suspended']?.userId ?? '';
      await db
        .updateTable('workspace_members')
        .set({
          access_kind: 'guest',
          guest_since: new Date(now.getTime() - 60_000),
          guest_modules: ['chat'],
        })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', 'in', [guestId, expiredId])
        .execute();
      await db
        .updateTable('workspace_members')
        .set({ guest_expires_at: new Date(now.getTime() - 1_000) })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', expiredId)
        .execute();
      await db
        .updateTable('users')
        .set({ suspended_at: now })
        .where('id', '=', suspendedId)
        .execute();
      const elsewhere = await aRoom(db, ['elsewhere-owner']);
      await db
        .insertInto('workspace_members')
        .values(
          [expiredId, room.outsiders['unshared']?.userId ?? ''].map((userId) => ({
            workspace_id: elsewhere.workspaceId,
            user_id: userId,
            role: 'member' as const,
          })),
        )
        .execute();
      await db
        .insertInto('channel_members')
        .values(
          [expiredId, room.outsiders['unshared']?.userId ?? ''].map((userId) => ({
            channel_id: elsewhere.channelId,
            user_id: userId,
          })),
        )
        .execute();
      const guest = await requireWorkspaceMembership(db, guestId, room.workspaceId);
      expect(
        (await membersIn(db, guest, chatWorkspaceChannels)).map((row) => row.user.id).sort(),
      ).toEqual([guestId, room.members['owner']?.userId ?? ''].sort());
      const channel = await requireChannelById(db, guestId, room.channelId);
      expect((await channelMembers(db, channel)).map((row) => row.user.id).sort()).toEqual(
        [guestId, room.members['owner']?.userId ?? ''].sort(),
      );
      const owner = await requireWorkspaceMembership(
        db,
        room.members['owner']?.userId ?? '',
        room.workspaceId,
      );
      expect(await membersIn(db, owner)).toHaveLength(5);
      expect(await attempt(db, () => membersIn(db, guest))).toBe('WORKSPACE_NOT_FOUND');
      await withinRequest(
        {
          requestId: 'guest-directory-module-off',
          startedAt: performance.now(),
          entitlements: {
            effective: (rows, now) =>
              effectiveModules({
                rows,
                now,
                mode: 'open',
                suspended: new Set(['chat']),
                running: [{ id: 'chat', requires: [], entitlement: 'always' }],
              }),
            refused: () => undefined,
          },
        },
        async () => {
          const stopped = await requireWorkspaceMembership(db, guestId, room.workspaceId);
          expect(await membersIn(db, stopped, chatWorkspaceChannels)).toEqual([]);
        },
      );
      await db
        .deleteFrom('channel_members')
        .where('user_id', '=', guestId)
        .where('channel_id', '=', room.channelId)
        .execute();
      expect(await membersIn(db, guest, chatWorkspaceChannels)).toEqual([]);
    });
  });
});
