/** @needs-modules chat — legacy administration keeps the same native source authority. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { aRoom } from '../../../testing/rooms';
import { fixedClock } from '../../../platform/clock';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { chatWorkspaceChannels } from '../../../features/chat/channels/workspace-channels';
import { joinChannel } from '../../../features/chat/channels/channels';
import { requireChannelById } from '../../../features/chat/channels/guard';
import { leaveChannel } from '../../../features/chat/channels/settings';
import { changeRole, removeMember } from '../members';
import { createInvitation } from '../invitations';
import { requireLegacyAdmissionOpen, recordLegacyManualAdmission } from './legacy-writers';
import { requireManualWorkspaceSource } from './native-state';
import { projectWorkspaceAccess } from './projection';
import { lockWorkspaceProjectionScope } from './scope';

const clock = fixedClock(new Date('2026-11-12T18:00:00Z'));
const rejected = async (promise: Promise<unknown>): Promise<unknown> =>
  await promise.then(
    () => {
      throw new Error('Expected this operation to be refused.');
    },
    (error: unknown): unknown => error,
  );

afterAll(closeIntegrationDatabase);

describe('integration: existing writers preserve source authority', () => {
  test('finite workspace delegation permits invitations and ordinary removal, never privileged roles, and removal fences replay', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'helper', 'person', 'admin']);
      const owner = room.members['owner'];
      const helper = room.members['helper'];
      const person = room.members['person'];
      const admin = room.members['admin'];
      if (
        owner === undefined ||
        helper === undefined ||
        person === undefined ||
        admin === undefined
      )
        throw new Error('Missing fixture people.');
      await db
        .updateTable('workspace_members')
        .set({ role: 'admin' })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', admin.userId)
        .execute();
      const scope = await lockWorkspaceProjectionScope(db, room.workspaceId);
      const helperSource = await requireManualWorkspaceSource(db, clock, scope, helper.userId);
      await requireManualWorkspaceSource(db, clock, scope, person.userId);
      const role = await db
        .insertInto('workspace_access_roles')
        .values({
          workspace_id: room.workspaceId,
          name: 'People helper',
          capabilities: ['members.invite', 'members.manage_nonowners'],
          created_at: clock.now(),
          updated_at: clock.now(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('workspace_access_role_grants')
        .values({
          workspace_id: room.workspaceId,
          role_id: role.id,
          source_id: helperSource.id,
          created_at: clock.now(),
        })
        .execute();
      await projectWorkspaceAccess(db, clock, scope, [helper.userId], chatWorkspaceChannels);
      const context = await requireWorkspaceMembership(db, helper.userId, room.workspaceId);
      expect((await createInvitation(db, clock, context)).invitation.id).toBeString();
      expect(await rejected(changeRole(db, clock, context, person.userId, 'admin'))).toMatchObject({
        body: { code: 'FORBIDDEN' },
      });
      expect(
        await rejected(removeMember(db, clock, context, admin.userId, chatWorkspaceChannels)),
      ).toMatchObject({ body: { code: 'FORBIDDEN' } });
      expect(
        await rejected(removeMember(db, clock, context, owner.userId, chatWorkspaceChannels)),
      ).toMatchObject({ body: { code: 'FORBIDDEN' } });
      await removeMember(db, clock, context, person.userId, chatWorkspaceChannels);
      expect(
        (
          await db
            .selectFrom('workspace_admission_controls')
            .select('blocked_at')
            .where('workspace_id', '=', room.workspaceId)
            .where('user_id', '=', person.userId)
            .executeTakeFirstOrThrow()
        ).blocked_at,
      ).not.toBeNull();
      await projectWorkspaceAccess(db, clock, scope, [person.userId], chatWorkspaceChannels);
      expect(
        await db
          .selectFrom('workspace_members')
          .select('id')
          .where('workspace_id', '=', room.workspaceId)
          .where('user_id', '=', person.userId)
          .executeTakeFirst(),
      ).toBeUndefined();
      expect(
        await rejected(requireLegacyAdmissionOpen(db, room.workspaceId, person.userId)),
      ).toMatchObject({ body: { code: 'INVITATION_NOT_FOUND' } });
    });
  });

  test('legacy role PATCH updates existing manual provenance and refuses an initialized directory-only member', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'manual', 'managed']);
      const owner = room.members['owner'];
      const manual = room.members['manual'];
      const managed = room.members['managed'];
      if (owner === undefined || manual === undefined || managed === undefined)
        throw new Error('Missing fixture people.');
      const scope = await lockWorkspaceProjectionScope(db, room.workspaceId);
      const source = await requireManualWorkspaceSource(db, clock, scope, manual.userId);
      await db
        .insertInto('workspace_admission_controls')
        .values({
          workspace_id: room.workspaceId,
          user_id: managed.userId,
          last_builtin_role: 'member',
          last_access_kind: 'member',
          initialized_at: clock.now(),
          updated_at: clock.now(),
        })
        .execute();
      await db
        .insertInto('workspace_access_sources')
        .values({
          workspace_id: room.workspaceId,
          user_id: managed.userId,
          kind: 'directory',
          directory_id: crypto.randomUUID(),
          directory_link_reference: crypto.randomUUID(),
          state: 'active',
          builtin_role: 'member',
          access_kind: 'member',
          admitted_at: clock.now(),
          created_at: clock.now(),
          updated_at: clock.now(),
        })
        .execute();
      const context = await requireWorkspaceMembership(db, owner.userId, room.workspaceId);
      await changeRole(db, clock, context, manual.userId, 'admin');
      expect(
        (
          await db
            .selectFrom('workspace_access_sources')
            .select('builtin_role')
            .where('id', '=', source.id)
            .executeTakeFirstOrThrow()
        ).builtin_role,
      ).toBe('admin');
      await projectWorkspaceAccess(db, clock, scope, [manual.userId], chatWorkspaceChannels);
      expect((await requireWorkspaceMembership(db, manual.userId, room.workspaceId)).role).toBe(
        'admin',
      );
      expect(await rejected(changeRole(db, clock, context, managed.userId, 'admin'))).toMatchObject(
        {
          body: { code: 'WORKSPACE_MEMBERSHIP_MANAGED' },
        },
      );
      expect(
        await db
          .selectFrom('workspace_access_sources')
          .select('id')
          .where('workspace_id', '=', room.workspaceId)
          .where('user_id', '=', managed.userId)
          .where('kind', '=', 'manual')
          .execute(),
      ).toEqual([]);
    });
  });

  test('an actual native join applies a preconfigured scoped role immediately; deliberate departure stays departed after projection', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner'], { outsiders: ['joiner'] });
      const person = room.outsiders['joiner'];
      if (person === undefined) throw new Error('Missing joiner.');
      const scope = await lockWorkspaceProjectionScope(db, room.workspaceId);
      const source = await requireManualWorkspaceSource(db, clock, scope, person.userId);
      const role = await db
        .insertInto('workspace_access_roles')
        .values({
          workspace_id: room.workspaceId,
          name: 'Channel helper',
          capabilities: ['channel.settings.manage'],
          created_at: clock.now(),
          updated_at: clock.now(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('channel_access_role_grants')
        .values({
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          role_id: role.id,
          source_id: source.id,
          created_at: clock.now(),
        })
        .execute();
      const context = await requireChannelById(db, person.userId, room.channelId);
      expect(await joinChannel(db, clock, context)).toBe(true);
      expect(
        await db
          .selectFrom('channel_member_capabilities')
          .select('capability')
          .where('channel_id', '=', room.channelId)
          .where('user_id', '=', person.userId)
          .execute(),
      ).toEqual([{ capability: 'channel.settings.manage' }]);
      await leaveChannel(db, await requireChannelById(db, person.userId, room.channelId));
      await projectWorkspaceAccess(db, clock, scope, [person.userId], chatWorkspaceChannels);
      expect(
        await db
          .selectFrom('channel_members')
          .select('id')
          .where('channel_id', '=', room.channelId)
          .where('user_id', '=', person.userId)
          .execute(),
      ).toEqual([]);
    });
  });
});

describe('integration: explicit native admission provenance', () => {
  test('only an actual explicit native admission creates fresh manual provenance after a retired source', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'person']);
      const person = room.members['person'];
      if (person === undefined) throw new Error('Missing native member.');
      const scope = await lockWorkspaceProjectionScope(db, room.workspaceId);
      const original = await requireManualWorkspaceSource(db, clock, scope, person.userId);
      await db
        .updateTable('workspace_members')
        .set({ role: 'admin' })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', person.userId)
        .execute();
      await recordLegacyManualAdmission(db, clock, room.workspaceId, person.userId);
      const changed = await db
        .selectFrom('workspace_access_sources')
        .selectAll()
        .where('id', '=', original.id)
        .executeTakeFirstOrThrow();
      expect(changed.builtin_role).toBe('admin');
      expect(changed.authorization_revision).not.toBe(original.authorization_revision);
      await db
        .updateTable('workspace_access_sources')
        .set({
          state: 'retired',
          retired_at: clock.now(),
          revision: crypto.randomUUID(),
          authorization_revision: crypto.randomUUID(),
        })
        .where('id', '=', original.id)
        .execute();
      await db
        .deleteFrom('workspace_members')
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', person.userId)
        .execute();
      await db
        .insertInto('workspace_members')
        .values({
          workspace_id: room.workspaceId,
          user_id: person.userId,
          role: 'member',
          joined_at: clock.now(),
        })
        .execute();
      await recordLegacyManualAdmission(db, clock, room.workspaceId, person.userId);
      const admitted = await requireManualWorkspaceSource(db, clock, scope, person.userId);
      expect(admitted.id).not.toBe(original.id);
      expect(admitted.builtin_role).toBe('member');
      expect(
        (
          await db
            .selectFrom('workspace_access_sources')
            .select('state')
            .where('id', '=', original.id)
            .executeTakeFirstOrThrow()
        ).state,
      ).toBe('retired');
      expect((await requireWorkspaceMembership(db, person.userId, room.workspaceId)).role).toBe(
        'member',
      );
    });
  });
});
