/** Delegated actions consume actual native channel projection rows, never membership or visibility substitutes. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Transaction } from '@purlay/db';
import type { ChannelAccessAction } from '@purlay/types';
import { fixedClock } from '../../../platform/clock';
import { AppError } from '../../../platform/errors';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { attempt } from '../../../testing/attempt';
import { aRoom } from '../../../testing/rooms';
import { initializeWorkspaceAdmission } from '../../../modules/workspaces/provisioning/native-state';
import { lockWorkspaceProjectionScope } from '../../../modules/workspaces/provisioning/scope';
import { membershipsOf } from '../../../modules/workspaces/workspaces';
import {
  noWorkspaceChannels,
  type WorkspaceChannels,
} from '../../../modules/workspaces/channels-port';
import { requireChannelById } from './guard';
import {
  aggregateChannelCapabilities,
  channelCapabilitiesFor,
  hasChannelCapability,
} from './access-capabilities';
import { channelFor } from './channels';
import {
  archiveChannel,
  archivedChannels,
  removeChannelMember,
  restoreChannel,
  updateChannel,
} from './settings';
const clock = fixedClock(new Date('2026-11-12T12:00:00Z'));
afterAll(closeIntegrationDatabase);
const outcome = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    await work();
    return 'allowed';
  } catch (error) {
    if (error instanceof AppError) return error.body.code;
    throw error;
  }
};
const grant = async (
  db: Transaction,
  workspaceId: string,
  channelId: string,
  userId: string,
  capabilities: readonly ChannelAccessAction[],
): Promise<void> => {
  const scope = await lockWorkspaceProjectionScope(db, workspaceId);
  await initializeWorkspaceAdmission(db, clock, scope, userId);
  const revision = crypto.randomUUID();
  await db
    .insertInto('channel_access_controls')
    .values({
      workspace_id: workspaceId,
      channel_id: channelId,
      user_id: userId,
      revision,
      initialized_at: clock.now(),
    })
    .onConflict((c) => c.columns(['channel_id', 'user_id']).doUpdateSet({ revision }))
    .execute();
  await db
    .deleteFrom('channel_member_capabilities')
    .where('channel_id', '=', channelId)
    .where('user_id', '=', userId)
    .execute();
  if (capabilities.length > 0)
    await db
      .insertInto('channel_member_capabilities')
      .values(
        capabilities.map((capability) => ({
          workspace_id: workspaceId,
          channel_id: channelId,
          user_id: userId,
          capability,
          projection_revision: revision,
        })),
      )
      .execute();
};
const channels: WorkspaceChannels = {
  ...noWorkspaceChannels,
  access: {
    aggregateCapabilities: aggregateChannelCapabilities,
    project: () => Promise.resolve([]),
    countFor: () => Promise.resolve(0),
    roleUsers: () => Promise.resolve([]),
  },
};
describe('integration: scoped channel management capabilities', () => {
  test('a full joined member can manage posting, archive and exact restore and remove ordinary public members; DTO and workspace hints stay finite', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'delegate', 'ordinary']);
      const person = room.members['delegate']?.userId ?? '';
      const target = room.members['ordinary']?.userId ?? '';
      await grant(db, room.workspaceId, room.channelId, person, [
        'channel.settings.manage',
        'channel.members.manage',
      ]);
      const context = await requireChannelById(db, person, room.channelId);
      const workspace = await requireWorkspaceMembership(db, person, room.workspaceId);
      expect((await channelFor(db, person, room.channelId)).channelCapabilities).toEqual([
        'channel.members.manage',
        'channel.settings.manage',
      ]);
      expect(
        (await membershipsOf(db, clock, person, undefined, undefined, channels))[0]
          ?.channelCapabilities,
      ).toEqual(['channel.members.manage', 'channel.settings.manage']);
      expect(
        (await updateChannel(db, clock, context, { onlyAdminsPost: true })).channel.onlyAdminsPost,
      ).toBe(true);
      expect(await removeChannelMember(db, clock, context, target)).toBe('removed');
      await archiveChannel(db, clock, context);
      expect((await archivedChannels(db, workspace)).map((row) => row.id)).toContain(
        room.channelId,
      );
      expect((await restoreChannel(db, clock, person, room.channelId)).workspaceId).toBe(
        room.workspaceId,
      );
    });
  });
  test('settings and member-management grants stay independent in both directions', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'delegate', 'ordinary']);
      const person = room.members['delegate']?.userId ?? '';
      const target = room.members['ordinary']?.userId ?? '';
      const context = await requireChannelById(db, person, room.channelId);
      await grant(db, room.workspaceId, room.channelId, person, ['channel.settings.manage']);
      expect(await hasChannelCapability(db, context, 'channel.members.manage')).toBe(false);
      expect(
        (await updateChannel(db, clock, context, { onlyAdminsPost: true })).channel.onlyAdminsPost,
      ).toBe(true);
      expect(await outcome(async () => await removeChannelMember(db, clock, context, target))).toBe(
        'FORBIDDEN',
      );
      await grant(db, room.workspaceId, room.channelId, person, ['channel.members.manage']);
      expect(await hasChannelCapability(db, context, 'channel.settings.manage')).toBe(false);
      expect(
        await outcome(
          async () => await updateChannel(db, clock, context, { onlyAdminsPost: false }),
        ),
      ).toBe('FORBIDDEN');
      expect(await removeChannelMember(db, clock, context, target)).toBe('removed');
    });
  });
  test('stale projection, blocked admission, missing native join, guests and DMs grant no custom action; delegated members cannot remove workspace admins', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'delegate', 'ordinary']);
      const person = room.members['delegate']?.userId ?? '';
      const owner = room.members['owner']?.userId ?? '';
      await grant(db, room.workspaceId, room.channelId, person, [
        'channel.settings.manage',
        'channel.members.manage',
      ]);
      const context = await requireChannelById(db, person, room.channelId);
      expect(await outcome(async () => await removeChannelMember(db, clock, context, owner))).toBe(
        'FORBIDDEN',
      );
      await db
        .updateTable('channel_access_controls')
        .set({ revision: crypto.randomUUID() })
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', person)
        .execute();
      expect(await hasChannelCapability(db, context, 'channel.settings.manage')).toBe(false);
      expect(
        await outcome(
          async () => await updateChannel(db, clock, context, { onlyAdminsPost: true }),
        ),
      ).toBe('FORBIDDEN');
      await grant(db, room.workspaceId, room.channelId, person, ['channel.settings.manage']);
      await db
        .updateTable('workspace_admission_controls')
        .set({ blocked_at: clock.now(), revision: crypto.randomUUID(), updated_at: clock.now() })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', person)
        .execute();
      expect(await hasChannelCapability(db, context, 'channel.settings.manage')).toBe(false);
      await db
        .updateTable('workspace_admission_controls')
        .set({ blocked_at: null, revision: crypto.randomUUID(), updated_at: clock.now() })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', person)
        .execute();
      await db
        .deleteFrom('channel_members')
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', person)
        .execute();
      expect(await hasChannelCapability(db, context, 'channel.settings.manage')).toBe(false);
      await db
        .insertInto('channel_members')
        .values({ channel_id: room.channelId, user_id: person })
        .execute();
      await db
        .updateTable('workspace_members')
        .set({ access_kind: 'guest', guest_since: clock.now(), guest_modules: ['chat'] })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', person)
        .execute();
      expect(await hasChannelCapability(db, context, 'channel.settings.manage')).toBe(false);
      const dm = await aRoom(db, ['dm-owner', 'dm-delegate'], { type: 'direct_message' });
      const dmPerson = dm.members['dm-delegate']?.userId ?? '';
      expect(
        await attempt(db, async (): Promise<void> => {
          await grant(db, dm.workspaceId, dm.channelId, dmPerson, ['channel.settings.manage']);
        }),
      ).toContain('exact non-DM channel');
      expect(
        await hasChannelCapability(
          db,
          await requireChannelById(db, dmPerson, dm.channelId),
          'channel.settings.manage',
        ),
      ).toBe(false);
    });
  });
  test('a scoped archived grant reveals only its exact native visible channel and capability hydration remains one batch for one or many channels', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'delegate']);
      const person = room.members['delegate']?.userId ?? '';
      await grant(db, room.workspaceId, room.channelId, person, ['channel.settings.manage']);
      const other = await db
        .insertInto('channels')
        .values({
          workspace_id: room.workspaceId,
          name: 'other-archived',
          type: 'public',
          created_by: room.members['owner']?.userId ?? '',
          deleted_at: clock.now(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('channel_members')
        .values({ channel_id: other.id, user_id: person })
        .execute();
      await db
        .updateTable('channels')
        .set({ deleted_at: clock.now() })
        .where('id', '=', room.channelId)
        .execute();
      const context = await requireWorkspaceMembership(db, person, room.workspaceId);
      expect((await archivedChannels(db, context)).map((row) => row.id)).toEqual([room.channelId]);
      expect(await outcome(async () => await restoreChannel(db, clock, person, other.id))).toBe(
        'FORBIDDEN',
      );
      let selects = 0;
      const observed = db.withPlugin({
        transformQuery: (args) => {
          if (args.node.kind === 'SelectQueryNode') selects++;
          return args.node;
        },
        transformResult: (args) => Promise.resolve(args.result),
      });
      await channelCapabilitiesFor(observed, person, [room.channelId]);
      expect(selects).toBe(1);
      selects = 0;
      await channelCapabilitiesFor(observed, person, [
        room.channelId,
        other.id,
        ...Array.from({ length: 18 }, () => crypto.randomUUID()),
      ]);
      expect(selects).toBe(1);
    });
  });
});
