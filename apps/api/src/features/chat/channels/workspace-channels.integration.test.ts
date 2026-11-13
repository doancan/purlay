/**
 * What chat answers for a workspace's channels when a person leaves the workspace (D-250), in a database where chat's own
 * set was never applied — the core alone, or another module's set on it. The answer is held whether chat runs or not, so it
 * must not name a table that set makes: `channel_departures` is chat's (`chat/0006`), and a person's removal from a
 * workspace answered 500 where it was absent.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  cloneIntegrationDatabase,
  DROP_HOOK_MS,
  sql,
  withRollback,
  type ClonedDatabase,
} from '@purlay/db';
import { aRoom } from '../../../testing/rooms';
import { chatWorkspaceChannels } from './workspace-channels';
import { fixedClock } from '../../../platform/clock';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { initializeWorkspaceAdmission } from '../../../modules/workspaces/provisioning/native-state';
import { lockWorkspaceProjectionScope } from '../../../modules/workspaces/channels-port';
import { channelCapabilitiesFor, hasChannelCapability } from './access-capabilities';
import { prepareManualChannelAdmission } from './access-projection';
import { attempt } from '../../../testing/attempt';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);

afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

describe('integration: leaving a workspace, with and without the set that keeps how people left channels', () => {
  test('forgets the channels a person was in, and how they left one, where the table is there', async () => {
    const room = await aRoom(cloned.db, ['ayşe', 'burak']);
    const userId = room.members['burak']?.userId ?? '';
    await sql`insert into channel_departures (channel_id, user_id, reason)
      values (${room.channelId}, ${userId}, 'left')`.execute(cloned.db);
    const left = await chatWorkspaceChannels.leaveAll(cloned.db, room.workspaceId, userId);
    expect(left).toContain(room.channelId);
    const kept = await sql`select 1 from channel_departures where user_id = ${userId}`.execute(
      cloned.db,
    );
    expect(kept.rows).toEqual([]);
  });

  test('still leaves the channels where chat’s set was never applied, which has no such table', async () => {
    await sql`drop table channel_departures`.execute(cloned.db);
    const room = await aRoom(cloned.db, ['can', 'deniz']);
    const userId = room.members['deniz']?.userId ?? '';
    const left = await chatWorkspaceChannels.leaveAll(cloned.db, room.workspaceId, userId);
    expect(left).toContain(room.channelId);
    const member = await sql`select 1 from channel_members where user_id = ${userId}`.execute(
      cloned.db,
    );
    expect(member.rows).toEqual([]);
  });

  test('core-only access administration preserves active legacy channels and removes an offboarded audience without optional chat ledgers', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'member', 'source-ended', 'uninitialized']);
      const ownerId = room.members['owner']?.userId ?? '';
      const userId = room.members['member']?.userId ?? '';
      const sourceEndedId = room.members['source-ended']?.userId ?? '';
      const uninitializedId = room.members['uninitialized']?.userId ?? '';
      const clock = fixedClock(new Date('2026-11-13T10:00:00Z'));
      const context = await requireWorkspaceMembership(db, ownerId, room.workspaceId);
      const scope = await lockWorkspaceProjectionScope(db, room.workspaceId);
      await initializeWorkspaceAdmission(db, clock, scope, userId);
      await initializeWorkspaceAdmission(db, clock, scope, sourceEndedId);
      await sql`drop table channel_member_capabilities, channel_access_role_grants,
        channel_access_member_grants, channel_access_group_mappings, channel_access_controls`.execute(
        db,
      );

      const access = chatWorkspaceChannels.access;
      const grants = access?.grants;
      if (access === undefined || grants === undefined)
        throw new Error('Missing chat access adapter');
      expect(await channelCapabilitiesFor(db, userId, [room.channelId])).toEqual(new Map());
      expect(
        await hasChannelCapability(
          db,
          { workspaceId: room.workspaceId, channelId: room.channelId, userId },
          'channel.settings.manage',
        ),
      ).toBe(false);
      await (
        await prepareManualChannelAdmission(db, clock, context, [userId])
      )(room.channelId);
      expect(await access.aggregateCapabilities(db, userId, [room.workspaceId])).toEqual(new Map());
      expect(await access.countFor(db, room.workspaceId, userId)).toBe(1);
      expect(await access.roleUsers(db, room.workspaceId, crypto.randomUUID())).toEqual([]);
      expect(await grants.list(db, context, scope, {}, 2)).toEqual([]);
      expect(await grants.find(db, context, scope, crypto.randomUUID())).toBeUndefined();
      expect(
        await attempt(db, async () => await grants.descriptor(db, context, scope, room.channelId)),
      ).toBe('CHANNEL_NOT_FOUND');
      expect(
        await attempt(db, async (): Promise<void> => {
          await grants.revoke(db, context, scope, crypto.randomUUID());
        }),
      ).toBe('WORKSPACE_ACCESS_GRANT_NOT_FOUND');
      expect(
        await attempt(
          db,
          async () =>
            await grants.assign(db, clock, context, scope, {
              roleId: crypto.randomUUID(),
              subject: { kind: 'source', sourceId: crypto.randomUUID() },
              channelId: room.channelId,
            }),
        ),
      ).toBe('CHANNEL_NOT_FOUND');
      expect(await access.project(db, clock, scope, [userId])).toEqual([]);
      expect(await access.countFor(db, room.workspaceId, userId)).toBe(1);
      expect(await access.project(db, clock, scope, [uninitializedId])).toEqual([]);
      expect(await access.countFor(db, room.workspaceId, uninitializedId)).toBe(1);

      await db
        .updateTable('workspace_access_sources')
        .set({
          state: 'inactive',
          revision: crypto.randomUUID(),
          authorization_revision: crypto.randomUUID(),
        })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', sourceEndedId)
        .execute();
      expect(await access.project(db, clock, scope, [sourceEndedId])).toEqual([room.channelId]);
      expect(await access.countFor(db, room.workspaceId, sourceEndedId)).toBe(0);

      await db
        .updateTable('workspace_admission_controls')
        .set({ blocked_at: clock.now(), revision: crypto.randomUUID() })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', userId)
        .execute();
      expect(await access.project(db, clock, scope, [userId])).toEqual([room.channelId]);
      expect(await access.countFor(db, room.workspaceId, userId)).toBe(0);
      expect((await sql<{ alive: number }>`select 1 as alive`.execute(db)).rows).toEqual([
        { alive: 1 },
      ]);
    }, cloned.db);
  });
});
