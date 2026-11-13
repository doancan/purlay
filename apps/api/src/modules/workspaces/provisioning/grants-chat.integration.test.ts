/** @needs-modules chat — scoped grants use chat's actual independent visibility and native projection. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Transaction } from '@purlay/db';
import { chatWorkspaceChannels } from '../../../features/chat/channels/workspace-channels';
import { chatChannelAccessGrants } from '../../../features/chat/channels/access-grants';
import { requireChannelById } from '../../../features/chat/channels/guard';
import { fixedClock } from '../../../platform/clock';
import { AppError } from '../../../platform/errors';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { aRoom } from '../../../testing/rooms';
import { attempt } from '../../../testing/attempt';
import { createChannel } from '../../../features/chat/channels/channels';
import { recordPrimaryAuthentication } from '../../auth/authentication-evidence';
import { NO_SESSION_LIFETIME } from '../../auth/session-lifetime';
import type { WorkspaceProvisioningActor, WorkspaceProvisioningDependencies } from './authority';
import {
  assignWorkspaceAccessGrant,
  listWorkspaceAccessGrants,
  revokeWorkspaceAccessGrant,
} from './grants';
import { requireManualWorkspaceSource } from './native-state';
import { projectWorkspaceAccess } from './projection';
import { lockWorkspaceProjectionScope } from './scope';
import { retireWorkspaceAccessRole } from './roles';
import { readWorkspaceMemberAccess } from './read-access';
import { offboardWorkspaceMember } from './source-offboarding';

const now = new Date('2026-11-12T18:00:00Z');
const clock = fixedClock(now);
afterAll(closeIntegrationDatabase);

const fixture = async (
  db: Transaction,
): Promise<{
  dependencies: WorkspaceProvisioningDependencies;
  actor: WorkspaceProvisioningActor;
  source: Awaited<ReturnType<typeof requireManualWorkspaceSource>>;
  role: { readonly id: string; readonly revision: string };
  channelId: string;
  targetId: string;
  effects: (() => Promise<void>)[];
}> => {
  const room = await aRoom(db, ['grant-chat-owner'], { outsiders: ['grant-chat-target'] });
  const owner = room.members['grant-chat-owner'];
  const target = room.outsiders['grant-chat-target'];
  if (owner === undefined || target === undefined)
    throw new Error('Missing chat grant fixture people.');
  const session = await db
    .insertInto('sessions')
    .values({
      user_id: owner.userId,
      token_hash: crypto.randomUUID(),
      created_at: now,
      last_used_at: now,
      expires_at: new Date(now.getTime() + 86_400_000),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await recordPrimaryAuthentication(db, session.id, owner.userId, {
    method: 'password',
    authenticatedAt: now,
  });
  const actor = {
    context: await requireWorkspaceMembership(db, owner.userId, room.workspaceId),
    sessionId: session.id,
  };
  const scope = await lockWorkspaceProjectionScope(db, room.workspaceId);
  await requireManualWorkspaceSource(db, clock, scope, owner.userId);
  const source = await requireManualWorkspaceSource(db, clock, scope, target.userId);
  const role = await db
    .insertInto('workspace_access_roles')
    .values({
      workspace_id: room.workspaceId,
      name: 'Mixed conversation helper',
      capabilities: ['audit.read', 'channel.settings.manage'],
      created_at: now,
      updated_at: now,
    })
    .returning(['id', 'revision'])
    .executeTakeFirstOrThrow();
  const effects: (() => Promise<void>)[] = [];
  return {
    actor,
    source,
    role,
    channelId: room.channelId,
    targetId: target.userId,
    effects,
    dependencies: {
      database: db,
      clock,
      lifetime: () => NO_SESSION_LIFETIME,
      readersReady: () => Promise.resolve(true),
      channels: chatWorkspaceChannels,
      afterCommit: (_transaction, effect): void => {
        effects.push(effect);
      },
      bus: {
        publish: (): Promise<void> => Promise.resolve(),
        subscribe: () => true,
        unsubscribe: (): void => undefined,
        forget: (): void => undefined,
      },
    },
  };
};

const refusal = async (body: () => Promise<unknown>): Promise<string> => {
  try {
    await body();
    return 'taken';
  } catch (error) {
    if (error instanceof AppError) return error.body.code;
    throw error;
  }
};

describe('integration: actual chat scoped grant port', () => {
  test('retiring an actual channel role and offboarding its native member recomputes authority and removes the real channel audience', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      await db
        .insertInto('channel_members')
        .values({ channel_id: f.channelId, user_id: f.targetId, joined_at: now })
        .execute();
      const scope = await lockWorkspaceProjectionScope(db, f.actor.context.workspaceId);
      await projectWorkspaceAccess(db, clock, scope, [f.targetId], chatWorkspaceChannels);
      await assignWorkspaceAccessGrant(f.dependencies, f.actor, {
        roleId: f.role.id,
        roleRevision: f.role.revision,
        subject: { kind: 'source', sourceId: f.source.id },
        subjectRevision: f.source.revision,
        scope: { kind: 'channel', channelId: f.channelId },
      });
      expect(
        await db
          .selectFrom('channel_member_capabilities')
          .select('capability')
          .where('channel_id', '=', f.channelId)
          .where('user_id', '=', f.targetId)
          .execute(),
      ).toEqual([{ capability: 'channel.settings.manage' }]);
      await retireWorkspaceAccessRole(f.dependencies, f.actor, f.role.id, {
        revision: f.role.revision,
      });
      expect(
        await db
          .selectFrom('channel_member_capabilities')
          .select('capability')
          .where('channel_id', '=', f.channelId)
          .where('user_id', '=', f.targetId)
          .execute(),
      ).toEqual([]);
      expect(
        await db
          .selectFrom('channel_members')
          .select('id')
          .where('channel_id', '=', f.channelId)
          .where('user_id', '=', f.targetId)
          .execute(),
      ).toHaveLength(1);
      const access = await readWorkspaceMemberAccess(f.dependencies, f.actor, f.targetId);
      expect(
        await offboardWorkspaceMember(f.dependencies, f.actor, f.targetId, {
          revision: access.revision,
          confirm: true,
        }),
      ).toMatchObject({ state: 'offboarded' });
      expect(
        await db
          .selectFrom('channel_members')
          .select('id')
          .where('channel_id', '=', f.channelId)
          .where('user_id', '=', f.targetId)
          .execute(),
      ).toEqual([]);
      const native = await aRoom(db, ['uncontrolled-native-owner']);
      const owner = native.members['uncontrolled-native-owner'];
      if (owner === undefined) throw new Error('Missing uncontrolled native owner');
      const context = await requireWorkspaceMembership(db, owner.userId, native.workspaceId);
      const created = await createChannel(db, clock, context, {
        name: 'native-before-provisioning',
        type: 'public',
      });
      expect(
        await db
          .selectFrom('channel_members')
          .select('user_id')
          .where('channel_id', '=', created.id)
          .execute(),
      ).toEqual([{ user_id: owner.userId }]);
      expect(
        await db
          .selectFrom('workspace_admission_controls')
          .select('user_id')
          .where('workspace_id', '=', native.workspaceId)
          .execute(),
      ).toEqual([]);
    });
  });
  test('the native port refuses ordinary members, foreign scopes, malformed ids and unbounded pages before exposing grants', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const scope = await lockWorkspaceProjectionScope(db, f.actor.context.workspaceId);
      const member = await requireWorkspaceMembership(db, f.targetId, scope.workspaceId);
      expect(
        await refusal(
          async () => await chatChannelAccessGrants.descriptor(db, member, scope, f.channelId),
        ),
      ).toBe('FORBIDDEN');
      const foreign = await aRoom(db, ['port-foreign-owner']);
      const foreignOwner = foreign.members['port-foreign-owner'];
      if (foreignOwner === undefined) throw new Error('Missing foreign native owner');
      const context = await requireWorkspaceMembership(
        db,
        foreignOwner.userId,
        foreign.workspaceId,
      );
      expect(
        await refusal(
          async () => await chatChannelAccessGrants.descriptor(db, context, scope, f.channelId),
        ),
      ).toBe('CHANNEL_NOT_FOUND');
      expect(
        await refusal(
          async () =>
            await chatChannelAccessGrants.descriptor(db, f.actor.context, scope, 'not-a-uuid'),
        ),
      ).toBe('CHANNEL_NOT_FOUND');
      expect(
        await chatChannelAccessGrants.find(db, f.actor.context, scope, 'not-a-uuid'),
      ).toBeUndefined();
      for (const take of [0, 102, 1.5]) {
        const failure: unknown = await chatChannelAccessGrants
          .list(db, f.actor.context, scope, {}, take)
          .catch((error: unknown) => error);
        expect(failure instanceof Error ? failure.message : null).toBe(
          'Channel grant listing requires a bounded page.',
        );
      }
      expect(
        await refusal(async () => {
          await chatChannelAccessGrants.revoke(db, f.actor.context, scope, crypto.randomUUID());
        }),
      ).toBe('WORKSPACE_ACCESS_GRANT_NOT_FOUND');
      expect(
        await db
          .selectFrom('channel_access_role_grants')
          .select('id')
          .where('workspace_id', '=', scope.workspaceId)
          .execute(),
      ).toEqual([]);
    });
  });

  test('retrying an actual group channel assignment returns its one original row and creates no native audience', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const scope = await lockWorkspaceProjectionScope(db, f.actor.context.workspaceId);
      const group = await db
        .insertInto('workspace_access_groups')
        .values({
          workspace_id: scope.workspaceId,
          name: 'Idempotent channel group',
          kind: 'manual',
          state: 'active',
          created_at: now,
          updated_at: now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const input = {
        roleId: f.role.id,
        subject: { kind: 'group' as const, groupId: group.id },
        channelId: f.channelId,
      };
      const first = await chatChannelAccessGrants.assign(db, clock, f.actor.context, scope, input);
      const repeated = await chatChannelAccessGrants.assign(
        db,
        clock,
        f.actor.context,
        scope,
        input,
      );
      expect(first.created).toBe(true);
      expect(repeated).toEqual({ ...first, created: false });
      expect(
        await db
          .selectFrom('channel_access_role_grants')
          .select('id')
          .where('workspace_id', '=', scope.workspaceId)
          .execute(),
      ).toEqual([{ id: first.id }]);
      expect(
        await db
          .selectFrom('channel_members')
          .select('id')
          .where('channel_id', '=', f.channelId)
          .where('user_id', '=', f.targetId)
          .execute(),
      ).toEqual([]);
    });
  });

  test('a source whose actual person was erased cannot return a new grant and the caller can roll the write back', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      await db.updateTable('users').set({ deleted_at: now }).where('id', '=', f.targetId).execute();
      const failure = await attempt(db, async () => {
        const scope = await lockWorkspaceProjectionScope(db, f.actor.context.workspaceId);
        await chatChannelAccessGrants.assign(db, clock, f.actor.context, scope, {
          roleId: f.role.id,
          subject: { kind: 'source', sourceId: f.source.id },
          channelId: f.channelId,
        });
      });
      expect(failure).toContain('Assigned channel grant was not visible to its author.');
      expect(
        await db
          .selectFrom('channel_access_role_grants')
          .select('id')
          .where('workspace_id', '=', f.actor.context.workspaceId)
          .execute(),
      ).toEqual([]);
    });
  });
  test('the port requires the exact locked transaction and native actor context', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const scope = await lockWorkspaceProjectionScope(db, f.actor.context.workspaceId);
      expect(
        await chatChannelAccessGrants.descriptor(db, f.actor.context, scope, f.channelId),
      ).toMatchObject({ id: f.channelId, name: 'general', type: 'public' });
      const copied = await chatChannelAccessGrants
        .descriptor(db, { ...f.actor.context }, scope, f.channelId)
        .catch((error: unknown) => error);
      expect(copied instanceof Error ? copied.message : null).toContain(
        'membership guard did not mint',
      );
      await withRollback(async (another) => {
        const failure = await chatChannelAccessGrants
          .descriptor(another, f.actor.context, scope, f.channelId)
          .catch((error: unknown) => error);
        expect(failure instanceof Error ? failure.message : null).toContain(
          'exact native locked transaction',
        );
      });
    });
  });

  test('a channel role creates no membership or workspace capability and applies only after independent native membership', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const input = {
        roleId: f.role.id,
        roleRevision: f.role.revision,
        subject: { kind: 'source' as const, sourceId: f.source.id },
        subjectRevision: f.source.revision,
        scope: { kind: 'channel' as const, channelId: f.channelId },
      };
      const grant = await assignWorkspaceAccessGrant(f.dependencies, f.actor, input);
      expect(grant.scope).toEqual({
        kind: 'channel',
        channelId: f.channelId,
        name: 'general',
        type: 'public',
      });
      expect(
        await db
          .selectFrom('channel_members')
          .select('id')
          .where('channel_id', '=', f.channelId)
          .where('user_id', '=', f.targetId)
          .execute(),
      ).toEqual([]);
      expect(
        await db
          .selectFrom('channel_member_capabilities')
          .select('capability')
          .where('channel_id', '=', f.channelId)
          .where('user_id', '=', f.targetId)
          .execute(),
      ).toEqual([]);
      expect(
        await db
          .selectFrom('workspace_member_capabilities')
          .select('capability')
          .where('workspace_id', '=', f.actor.context.workspaceId)
          .where('user_id', '=', f.targetId)
          .execute(),
      ).toEqual([]);
      expect(await assignWorkspaceAccessGrant(f.dependencies, f.actor, input)).toEqual(grant);
      expect(f.effects).toHaveLength(1);
      await db
        .insertInto('channel_members')
        .values({ channel_id: f.channelId, user_id: f.targetId, joined_at: now })
        .execute();
      const scope = await lockWorkspaceProjectionScope(db, f.actor.context.workspaceId);
      await projectWorkspaceAccess(db, clock, scope, [f.targetId], chatWorkspaceChannels);
      expect(
        await db
          .selectFrom('channel_member_capabilities')
          .select('capability')
          .where('channel_id', '=', f.channelId)
          .where('user_id', '=', f.targetId)
          .execute(),
      ).toEqual([{ capability: 'channel.settings.manage' }]);
      await revokeWorkspaceAccessGrant(f.dependencies, f.actor, grant.id, {
        revision: grant.revision,
      });
      expect(
        await db
          .selectFrom('channel_member_capabilities')
          .select('capability')
          .where('channel_id', '=', f.channelId)
          .where('user_id', '=', f.targetId)
          .execute(),
      ).toEqual([]);
      expect(
        await db
          .selectFrom('channel_members')
          .select('id')
          .where('channel_id', '=', f.channelId)
          .where('user_id', '=', f.targetId)
          .execute(),
      ).toHaveLength(1);
    });
  });

  test('private visibility, direct messages and tenant isolation are independently guarded for assign, list and revoke', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const workspaceId = f.actor.context.workspaceId;
      const privateChannel = await db
        .insertInto('channels')
        .values({ workspace_id: workspaceId, name: 'Private grant boundary', type: 'private' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const dm = await db
        .insertInto('channels')
        .values({
          workspace_id: workspaceId,
          type: 'direct_message',
          name: null,
          dm_key: [f.actor.context.userId, f.targetId].sort().join(':'),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('channel_members')
        .values({ channel_id: dm.id, user_id: f.actor.context.userId })
        .execute();
      const foreign = await aRoom(db, ['foreign-grant-owner']);
      const input = {
        roleId: f.role.id,
        roleRevision: f.role.revision,
        subject: { kind: 'source' as const, sourceId: f.source.id },
        subjectRevision: f.source.revision,
        scope: { kind: 'channel' as const, channelId: privateChannel.id },
      };
      for (const channelId of [privateChannel.id, dm.id, foreign.channelId, crypto.randomUUID()])
        expect(
          await refusal(
            async () =>
              await assignWorkspaceAccessGrant(f.dependencies, f.actor, {
                ...input,
                scope: { kind: 'channel', channelId },
              }),
          ),
        ).toBe('CHANNEL_NOT_FOUND');
      await db
        .insertInto('channel_members')
        .values({ channel_id: privateChannel.id, user_id: f.actor.context.userId })
        .execute();
      const grant = await assignWorkspaceAccessGrant(f.dependencies, f.actor, input);
      expect(grant.scope).toMatchObject({ name: 'Private grant boundary', type: 'private' });
      expect(
        await refusal(async () => await requireChannelById(db, f.targetId, privateChannel.id)),
      ).toBe('CHANNEL_NOT_FOUND');
      expect(
        (
          await listWorkspaceAccessGrants(f.dependencies, f.actor, { q: 'Private grant boundary' })
        ).data.map((row) => row.id),
      ).toEqual([grant.id]);
      await db
        .deleteFrom('channel_members')
        .where('channel_id', '=', privateChannel.id)
        .where('user_id', '=', f.actor.context.userId)
        .execute();
      expect((await listWorkspaceAccessGrants(f.dependencies, f.actor, {})).data).toEqual([]);
      expect(
        await refusal(async () => {
          await revokeWorkspaceAccessGrant(f.dependencies, f.actor, grant.id, {
            revision: grant.revision,
          });
        }),
      ).toBe('WORKSPACE_ACCESS_GRANT_NOT_FOUND');
      expect(
        await db
          .selectFrom('channel_access_role_grants')
          .select('id')
          .where('workspace_id', '=', workspaceId)
          .where('id', '=', grant.id)
          .execute(),
      ).toHaveLength(1);
    });
  });

  test('merged workspace and visible channel keysets include source and group metadata without omissions', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const workspaceId = f.actor.context.workspaceId;
      const group = await db
        .insertInto('workspace_access_groups')
        .values({
          workspace_id: workspaceId,
          kind: 'manual',
          name: 'Scoped helper group',
          state: 'active',
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await db
        .insertInto('workspace_access_group_members')
        .values({
          workspace_id: workspaceId,
          group_id: group.id,
          user_id: f.targetId,
          source_id: f.source.id,
          created_at: now,
        })
        .execute();
      const input = {
        roleId: f.role.id,
        roleRevision: f.role.revision,
        subject: { kind: 'source' as const, sourceId: f.source.id },
        subjectRevision: f.source.revision,
        scope: { kind: 'workspace' as const },
      };
      const workspaceGrant = await assignWorkspaceAccessGrant(f.dependencies, f.actor, input);
      const channelGrant = await assignWorkspaceAccessGrant(f.dependencies, f.actor, {
        ...input,
        scope: { kind: 'channel', channelId: f.channelId },
      });
      const groupGrant = await assignWorkspaceAccessGrant(f.dependencies, f.actor, {
        ...input,
        subject: { kind: 'group', groupId: group.id },
        subjectRevision: group.revision,
        scope: { kind: 'channel', channelId: f.channelId },
      });
      const ids: string[] = [];
      let before: string | null = null;
      for (let index = 0; index < 3; index++) {
        const page = await listWorkspaceAccessGrants(f.dependencies, f.actor, {
          limit: 1,
          ...(before === null ? {} : { before }),
        });
        expect(page.data).toHaveLength(1);
        ids.push(...page.data.map((row) => row.id));
        before = page.nextCursor;
      }
      expect(ids).toEqual([workspaceGrant.id, channelGrant.id, groupGrant.id].sort().reverse());
      expect(before).toBeNull();
      const sources = await listWorkspaceAccessGrants(f.dependencies, f.actor, {
        sourceId: f.source.id,
      });
      expect(sources.data.map((row) => row.id).sort()).toEqual(
        [workspaceGrant.id, channelGrant.id].sort(),
      );
      const groups = await listWorkspaceAccessGrants(f.dependencies, f.actor, {
        groupId: group.id,
        q: 'Scoped helper group',
      });
      expect(groups.data).toHaveLength(1);
      expect(groups.data[0]?.subject).toMatchObject({
        kind: 'group',
        group: { name: 'Scoped helper group', memberCount: 1 },
      });
      expect(
        (await listWorkspaceAccessGrants(f.dependencies, f.actor, { q: 'general' })).data
          .map((row) => row.id)
          .sort(),
      ).toEqual([channelGrant.id, groupGrant.id].sort());
    });
  });
});
