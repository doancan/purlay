/** The actual grant services preserve native admission and project only compatible current actions. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Transaction } from '@purlay/db';
import type { ServerFrame } from '@purlay/types';
import type { WorkspaceScopedCapability } from '@purlay/types/workspace-provisioning';
import { AppError } from '../../../platform/errors';
import { fixedClock } from '../../../platform/clock';
import { requireWorkspaceMembership, requireDeletionMembership } from '../../../platform/tenancy';
import { aUniqueSlug, aUserRow } from '../../../testing/users';
import { recordPrimaryAuthentication } from '../../auth/authentication-evidence';
import { NO_SESSION_LIFETIME } from '../../auth/session-lifetime';
import { noWorkspaceChannels } from '../channels-port';
import {
  requireWorkspaceCapabilityNow,
  type WorkspaceProvisioningActor,
  type WorkspaceProvisioningDependencies,
} from './authority';
import {
  assignWorkspaceAccessGrant,
  listWorkspaceAccessGrants,
  revokeWorkspaceAccessGrant,
} from './grants';
import { initializeWorkspaceAdmission, requireManualWorkspaceSource } from './native-state';
import { lockWorkspaceProjectionScope } from './scope';
import type { WorkspaceRoleRow } from './roles';
import { createWorkspaceAccessRole, retireWorkspaceAccessRole } from './roles';
import { previewWorkspaceOffboarding, offboardWorkspaceMember } from './source-offboarding';
import { readWorkspaceMemberAccess } from './read-access';
import { membershipsOf } from '../workspaces';
import { readRetention } from '../retention';
import { removeMember } from '../members';
import { askToDelete } from '../deletion';

const now = new Date('2026-11-12T18:00:00Z');
const clock = fixedClock(now);
afterAll(closeIntegrationDatabase);

const fixture = async (
  db: Transaction,
): Promise<{
  dependencies: WorkspaceProvisioningDependencies;
  actor: WorkspaceProvisioningActor;
  member: WorkspaceProvisioningActor;
  source: Awaited<ReturnType<typeof requireManualWorkspaceSource>>;
  effects: (() => Promise<void>)[];
  published: ServerFrame[];
}> => {
  const workspace = await db
    .insertInto('workspaces')
    .values({ name: 'Grant workspace', slug: aUniqueSlug('grants') })
    .returning('id')
    .executeTakeFirstOrThrow();
  const actors: WorkspaceProvisioningActor[] = [];
  for (const role of ['owner', 'member'] as const) {
    const user = await aUserRow(db, `grant-${role}`);
    await db
      .insertInto('workspace_members')
      .values({ workspace_id: workspace.id, user_id: user.userId, role, joined_at: now })
      .execute();
    const session = await db
      .insertInto('sessions')
      .values({
        user_id: user.userId,
        token_hash: crypto.randomUUID(),
        created_at: now,
        last_used_at: now,
        expires_at: new Date(now.getTime() + 86_400_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await recordPrimaryAuthentication(db, session.id, user.userId, {
      method: 'password',
      authenticatedAt: now,
    });
    actors.push({
      context: await requireWorkspaceMembership(db, user.userId, workspace.id),
      sessionId: session.id,
    });
  }
  const [actor, member] = actors;
  if (actor === undefined || member === undefined) throw new Error('Missing grant test actors.');
  const scope = await lockWorkspaceProjectionScope(db, workspace.id);
  await initializeWorkspaceAdmission(db, clock, scope, actor.context.userId);
  const source = await requireManualWorkspaceSource(db, clock, scope, member.context.userId);
  const effects: (() => Promise<void>)[] = [];
  const published: ServerFrame[] = [];
  return {
    actor,
    member,
    source,
    effects,
    published,
    dependencies: {
      database: db,
      clock,
      lifetime: () => NO_SESSION_LIFETIME,
      readersReady: () => Promise.resolve(true),
      channels: noWorkspaceChannels,
      afterCommit: (_transaction, effect): void => {
        effects.push(effect);
      },
      bus: {
        publish: (_topic, frame): Promise<void> => {
          published.push(frame);
          return Promise.resolve();
        },
        subscribe: () => true,
        unsubscribe: (): void => undefined,
        forget: (): void => undefined,
      },
    },
  };
};

const accessRole = async (
  db: Transaction,
  workspaceId: string,
  capabilities: readonly WorkspaceScopedCapability[] = ['audit.read'],
): Promise<WorkspaceRoleRow> =>
  await db
    .insertInto('workspace_access_roles')
    .values({
      workspace_id: workspaceId,
      name: crypto.randomUUID(),
      capabilities: [...capabilities],
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

const refusal = async (body: () => Promise<unknown>): Promise<string> => {
  try {
    await body();
    return 'taken';
  } catch (error) {
    if (error instanceof AppError) return error.body.code;
    throw error;
  }
};

describe('integration: exclusive scoped access grants', () => {
  test('a workspace with no chat projects a real delegated role, retires it and offboards the member without inventing channel authority', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const workspaceId = f.actor.context.workspaceId;
      const role = await createWorkspaceAccessRole(f.dependencies, f.actor, {
        name: 'Core-only audit reader',
        capabilities: ['audit.read', 'channel.settings.manage'],
      });
      await assignWorkspaceAccessGrant(f.dependencies, f.actor, {
        roleId: role.id,
        roleRevision: role.revision,
        subject: { kind: 'source', sourceId: f.source.id },
        subjectRevision: f.source.revision,
        scope: { kind: 'workspace' },
      });
      const memberships = await membershipsOf(
        db,
        clock,
        f.member.context.userId,
        undefined,
        undefined,
        noWorkspaceChannels,
      );
      expect(memberships.find((m) => m.workspace.id === workspaceId)).toMatchObject({
        role: 'member',
        workspaceCapabilities: ['audit.read'],
        channelCapabilities: [],
      });
      expect(
        await refusal(
          async () =>
            await assignWorkspaceAccessGrant(f.dependencies, f.actor, {
              roleId: role.id,
              roleRevision: role.revision,
              subject: { kind: 'source', sourceId: f.source.id },
              subjectRevision: f.source.revision,
              scope: { kind: 'channel', channelId: crypto.randomUUID() },
            }),
        ),
      ).toBe('CHANNEL_NOT_FOUND');
      await retireWorkspaceAccessRole(f.dependencies, f.actor, role.id, {
        revision: role.revision,
      });
      expect(
        await db
          .selectFrom('workspace_member_capabilities')
          .select('capability')
          .where('workspace_id', '=', workspaceId)
          .where('user_id', '=', f.member.context.userId)
          .execute(),
      ).toEqual([]);
      const access = await readWorkspaceMemberAccess(
        f.dependencies,
        f.actor,
        f.member.context.userId,
      );
      const preview = await previewWorkspaceOffboarding(
        f.dependencies,
        f.actor,
        f.member.context.userId,
        { revision: access.revision },
      );
      expect(preview).toMatchObject({ canOffboard: true, affectedChannelCount: 0 });
      const offboarded = await offboardWorkspaceMember(
        f.dependencies,
        f.actor,
        f.member.context.userId,
        { revision: access.revision, confirm: true },
      );
      expect(offboarded).toMatchObject({ state: 'offboarded', role: null });
      expect(
        await membershipsOf(
          db,
          clock,
          f.member.context.userId,
          undefined,
          undefined,
          noWorkspaceChannels,
        ),
      ).toEqual([]);
      expect(
        await db.selectFrom('sessions').select('id').where('id', '=', f.member.sessionId).execute(),
      ).toHaveLength(1);
      expect(await readRetention(db, f.actor.context, noWorkspaceChannels)).toEqual({
        retentionDays: null,
        channelsKeptLonger: 0,
      });
      const native = await aUserRow(db, 'core-only-uncontrolled-member');
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: workspaceId, user_id: native.userId, role: 'member' })
        .execute();
      expect(
        await removeMember(db, clock, f.actor.context, native.userId, noWorkspaceChannels),
      ).toMatchObject({ channelIds: [] });
      expect(
        await db
          .selectFrom('workspace_members')
          .select('id')
          .where('workspace_id', '=', workspaceId)
          .where('user_id', '=', native.userId)
          .execute(),
      ).toEqual([]);
      const deletionContext = await requireDeletionMembership(
        db,
        f.actor.context.userId,
        workspaceId,
      );
      const deletion = await askToDelete(
        db,
        clock,
        deletionContext,
        'Grant workspace',
        noWorkspaceChannels,
      );
      expect(deletion.channelIds).toEqual([]);
      expect(deletion.memberIds).toEqual([f.actor.context.userId]);
      expect(
        await db
          .selectFrom('workspaces')
          .select('deleted_at')
          .where('id', '=', workspaceId)
          .executeTakeFirstOrThrow(),
      ).toMatchObject({ deleted_at: now });
    });
  });
  test('mixed roles project their workspace subset, retries are quiet, and revoke preserves admission', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const role = await accessRole(db, f.actor.context.workspaceId, [
        'members.invite',
        'audit.read',
        'channel.settings.manage',
      ]);
      const input = {
        roleId: role.id,
        roleRevision: role.revision,
        subject: { kind: 'source' as const, sourceId: f.source.id },
        subjectRevision: f.source.revision,
        scope: { kind: 'workspace' as const },
      };
      const membership = await db
        .selectFrom('workspace_members')
        .select(['id', 'role', 'joined_at'])
        .where('workspace_id', '=', f.actor.context.workspaceId)
        .where('user_id', '=', f.member.context.userId)
        .executeTakeFirstOrThrow();
      const grant = await assignWorkspaceAccessGrant(f.dependencies, f.actor, input);
      expect(grant.role).toMatchObject({
        id: role.id,
        capabilities: ['members.invite', 'audit.read', 'channel.settings.manage'],
      });
      expect(grant.subject).toMatchObject({
        kind: 'source',
        sourceId: f.source.id,
        user: { id: f.member.context.userId },
        source: { effective: true },
      });
      expect(grant.scope).toEqual({ kind: 'workspace' });
      expect(
        await db
          .selectFrom('workspace_member_capabilities')
          .select('capability')
          .where('workspace_id', '=', f.actor.context.workspaceId)
          .where('user_id', '=', f.member.context.userId)
          .orderBy('capability')
          .execute(),
      ).toEqual([{ capability: 'audit.read' }, { capability: 'members.invite' }]);
      expect(f.effects).toHaveLength(1);
      expect(f.published).toHaveLength(0);
      expect(await assignWorkspaceAccessGrant(f.dependencies, f.actor, input)).toEqual(grant);
      expect(f.effects).toHaveLength(1);
      expect(
        await db
          .selectFrom('audit_log')
          .select('id')
          .where('workspace_id', '=', f.actor.context.workspaceId)
          .where('action', '=', 'workspace.access.grant_assigned')
          .execute(),
      ).toHaveLength(1);
      expect(
        await refusal(async () => {
          await revokeWorkspaceAccessGrant(f.dependencies, f.actor, grant.id, {
            revision: crypto.randomUUID(),
          });
        }),
      ).toBe('WORKSPACE_PROVISIONING_CHANGED');
      await revokeWorkspaceAccessGrant(f.dependencies, f.actor, grant.id, {
        revision: grant.revision,
      });
      expect(
        await db
          .selectFrom('workspace_member_capabilities')
          .select('capability')
          .where('workspace_id', '=', f.actor.context.workspaceId)
          .where('user_id', '=', f.member.context.userId)
          .execute(),
      ).toEqual([]);
      expect(
        await db
          .selectFrom('workspace_members')
          .select(['id', 'role', 'joined_at'])
          .where('workspace_id', '=', f.actor.context.workspaceId)
          .where('user_id', '=', f.member.context.userId)
          .executeTakeFirstOrThrow(),
      ).toEqual(membership);
      expect(
        (
          await db
            .selectFrom('workspace_access_sources')
            .select('state')
            .where('id', '=', f.source.id)
            .executeTakeFirstOrThrow()
        ).state,
      ).toBe('active');
      expect(f.effects).toHaveLength(2);
      expect(f.published).toHaveLength(0);
    });
  });

  test('role, source and group observations must all still be current', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const role = await accessRole(db, f.actor.context.workspaceId);
      const group = await db
        .insertInto('workspace_access_groups')
        .values({
          workspace_id: f.actor.context.workspaceId,
          kind: 'manual',
          name: 'Current team',
          state: 'active',
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const input = {
        roleId: role.id,
        roleRevision: role.revision,
        subject: { kind: 'source' as const, sourceId: f.source.id },
        subjectRevision: f.source.revision,
        scope: { kind: 'workspace' as const },
      };
      const currentRoleRevision = crypto.randomUUID();
      await db
        .updateTable('workspace_access_roles')
        .set({
          name: 'Role revised after observation',
          revision: currentRoleRevision,
          updated_at: now,
        })
        .where('workspace_id', '=', f.actor.context.workspaceId)
        .where('id', '=', role.id)
        .execute();
      await db
        .updateTable('workspace_access_sources')
        .set({
          name: 'Source revised after observation',
          revision: crypto.randomUUID(),
          updated_at: now,
        })
        .where('workspace_id', '=', f.actor.context.workspaceId)
        .where('id', '=', f.source.id)
        .execute();
      await db
        .updateTable('workspace_access_groups')
        .set({
          name: 'Group revised after observation',
          revision: crypto.randomUUID(),
          updated_at: now,
        })
        .where('workspace_id', '=', f.actor.context.workspaceId)
        .where('id', '=', group.id)
        .execute();
      expect(
        await refusal(
          async () =>
            await assignWorkspaceAccessGrant(f.dependencies, f.actor, {
              ...input,
            }),
        ),
      ).toBe('WORKSPACE_PROVISIONING_CHANGED');
      expect(
        await refusal(
          async () =>
            await assignWorkspaceAccessGrant(f.dependencies, f.actor, {
              ...input,
              roleRevision: currentRoleRevision,
            }),
        ),
      ).toBe('WORKSPACE_PROVISIONING_CHANGED');
      expect(
        await refusal(
          async () =>
            await assignWorkspaceAccessGrant(f.dependencies, f.actor, {
              ...input,
              roleRevision: currentRoleRevision,
              subject: { kind: 'group', groupId: group.id },
              subjectRevision: group.revision,
            }),
        ),
      ).toBe('WORKSPACE_PROVISIONING_CHANGED');
      expect(
        await db
          .selectFrom('workspace_access_role_grants')
          .select('id')
          .where('workspace_id', '=', f.actor.context.workspaceId)
          .execute(),
      ).toEqual([]);
      expect(f.effects).toHaveLength(0);
    });
  });

  test('a role without applicable actions, unrelated source or removed full membership cannot grant access', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const role = await accessRole(db, f.actor.context.workspaceId);
      const channelRole = await accessRole(db, f.actor.context.workspaceId, [
        'channel.members.manage',
      ]);
      const input = {
        roleId: role.id,
        roleRevision: role.revision,
        subject: { kind: 'source' as const, sourceId: f.source.id },
        subjectRevision: f.source.revision,
        scope: { kind: 'workspace' as const },
      };
      expect(
        await refusal(
          async () =>
            await assignWorkspaceAccessGrant(f.dependencies, f.actor, {
              ...input,
              roleId: channelRole.id,
              roleRevision: channelRole.revision,
            }),
        ),
      ).toBe('VALIDATION_FAILED');
      expect(
        await refusal(
          async () =>
            await assignWorkspaceAccessGrant(f.dependencies, f.actor, {
              ...input,
              subject: { kind: 'source', sourceId: crypto.randomUUID() },
            }),
        ),
      ).toBe('WORKSPACE_ACCESS_SOURCE_NOT_FOUND');
      await db
        .deleteFrom('workspace_members')
        .where('workspace_id', '=', f.actor.context.workspaceId)
        .where('user_id', '=', f.member.context.userId)
        .execute();
      expect(
        await refusal(async () => await assignWorkspaceAccessGrant(f.dependencies, f.actor, input)),
      ).toBe('WORKSPACE_ACCESS_SOURCE_NOT_FOUND');
      expect(
        await db
          .selectFrom('workspace_members')
          .select('id')
          .where('workspace_id', '=', f.actor.context.workspaceId)
          .where('user_id', '=', f.member.context.userId)
          .execute(),
      ).toEqual([]);
      expect(
        await db
          .selectFrom('workspace_access_role_grants')
          .select('id')
          .where('workspace_id', '=', f.actor.context.workspaceId)
          .execute(),
      ).toEqual([]);
    });
  });

  test('source A revocation preserves group B capability and independent manual membership', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const workspaceId = f.actor.context.workspaceId;
      const role = await accessRole(db, workspaceId, ['members.manage_nonowners']);
      const sources = await db
        .insertInto('workspace_access_sources')
        .values(
          ['Directory A', 'Directory B'].map((name) => ({
            workspace_id: workspaceId,
            user_id: f.member.context.userId,
            kind: 'directory',
            directory_id: crypto.randomUUID(),
            directory_link_reference: crypto.randomUUID(),
            name,
            state: 'active',
            builtin_role: 'member' as const,
            access_kind: 'member',
            admitted_at: now,
            created_at: now,
            updated_at: now,
          })),
        )
        .returningAll()
        .execute();
      const [a, b] = sources;
      if (a === undefined || b === undefined) throw new Error('Missing source cohort.');
      const group = await db
        .insertInto('workspace_access_groups')
        .values({
          workspace_id: workspaceId,
          kind: 'manual',
          name: 'Directory B helpers',
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
          user_id: f.member.context.userId,
          source_id: b.id,
          created_at: now,
        })
        .execute();
      const sourceGrant = await assignWorkspaceAccessGrant(f.dependencies, f.actor, {
        roleId: role.id,
        roleRevision: role.revision,
        subject: { kind: 'source', sourceId: a.id },
        subjectRevision: a.revision,
        scope: { kind: 'workspace' },
      });
      const groupGrant = await assignWorkspaceAccessGrant(f.dependencies, f.actor, {
        roleId: role.id,
        roleRevision: role.revision,
        subject: { kind: 'group', groupId: group.id },
        subjectRevision: group.revision,
        scope: { kind: 'workspace' },
      });
      expect(groupGrant.subject).toMatchObject({
        kind: 'group',
        group: { name: 'Directory B helpers', memberCount: 1 },
      });
      await revokeWorkspaceAccessGrant(f.dependencies, f.actor, sourceGrant.id, {
        revision: sourceGrant.revision,
      });
      await requireWorkspaceCapabilityNow(db, f.member.context, 'members.manage_nonowners');
      await revokeWorkspaceAccessGrant(f.dependencies, f.actor, groupGrant.id, {
        revision: groupGrant.revision,
      });
      expect(
        await refusal(async () => {
          await requireWorkspaceCapabilityNow(db, f.member.context, 'members.manage_nonowners');
        }),
      ).toBe('FORBIDDEN');
      expect(
        await db
          .selectFrom('workspace_access_sources')
          .select('id')
          .where('workspace_id', '=', workspaceId)
          .where('user_id', '=', f.member.context.userId)
          .where('state', '=', 'active')
          .execute(),
      ).toHaveLength(3);
      expect(
        (
          await db
            .selectFrom('workspace_members')
            .select('role')
            .where('workspace_id', '=', workspaceId)
            .where('user_id', '=', f.member.context.userId)
            .executeTakeFirstOrThrow()
        ).role,
      ).toBe('member');
    });
  });

  test('grant pages clamp to one hundred and use stable descending keysets with readable subject search', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const workspaceId = f.actor.context.workspaceId;
      const roles = await db
        .insertInto('workspace_access_roles')
        .values(
          Array.from({ length: 103 }, (_, index) => ({
            workspace_id: workspaceId,
            name: `Batch audit ${String(index)}`,
            capabilities: ['audit.read'],
            created_at: now,
            updated_at: now,
          })),
        )
        .returning('id')
        .execute();
      const inserted = await db
        .insertInto('workspace_access_role_grants')
        .values(
          roles.map((role) => ({
            workspace_id: workspaceId,
            role_id: role.id,
            source_id: f.source.id,
            created_at: now,
          })),
        )
        .returning('id')
        .execute();
      const first = await listWorkspaceAccessGrants(f.dependencies, f.actor, { limit: 500 });
      expect(first.data).toHaveLength(100);
      expect(first.nextCursor).toBe(first.data.at(-1)?.id ?? null);
      if (first.nextCursor === null) throw new Error('Expected a second grant page.');
      const next = await listWorkspaceAccessGrants(f.dependencies, f.actor, {
        limit: 100,
        before: first.nextCursor,
      });
      expect(next.data).toHaveLength(3);
      expect(next.nextCursor).toBeNull();
      expect([...first.data, ...next.data].map((grant) => grant.id)).toEqual(
        inserted
          .map((row) => row.id)
          .sort()
          .reverse(),
      );
      const byRole = await listWorkspaceAccessGrants(f.dependencies, f.actor, {
        q: 'audit 102',
        sourceId: f.source.id,
      });
      expect(byRole.data).toHaveLength(1);
      expect(byRole.data[0]?.role.name).toBe('Batch audit 102');
      expect(
        (await listWorkspaceAccessGrants(f.dependencies, f.actor, { q: 'grant-member', limit: 1 }))
          .data,
      ).toHaveLength(1);
      expect(
        (
          await listWorkspaceAccessGrants(f.dependencies, f.actor, {
            sourceId: crypto.randomUUID(),
          })
        ).data,
      ).toEqual([]);
    });
  });

  test('fresh native authority is required for reads and role grants never delegate grant administration', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const role = await accessRole(db, f.actor.context.workspaceId, [
        'members.invite',
        'members.manage_nonowners',
        'audit.read',
      ]);
      const grant = await assignWorkspaceAccessGrant(f.dependencies, f.actor, {
        roleId: role.id,
        roleRevision: role.revision,
        subject: { kind: 'source', sourceId: f.source.id },
        subjectRevision: f.source.revision,
        scope: { kind: 'workspace' },
      });
      expect(
        await refusal(async () => await listWorkspaceAccessGrants(f.dependencies, f.member, {})),
      ).toBe('FORBIDDEN');
      expect(
        await refusal(async () => {
          await revokeWorkspaceAccessGrant(f.dependencies, f.member, grant.id, {
            revision: grant.revision,
          });
        }),
      ).toBe('FORBIDDEN');
      await db
        .updateTable('sessions')
        .set({ revoked_at: now })
        .where('id', '=', f.actor.sessionId)
        .execute();
      expect(
        await refusal(async () => await listWorkspaceAccessGrants(f.dependencies, f.actor, {})),
      ).toBe('UNAUTHENTICATED');
    });
  });

  test('tenant resources stay opaque and the core-only service cannot create channel grants', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const other = await fixture(db);
      const role = await accessRole(db, f.actor.context.workspaceId, [
        'audit.read',
        'channel.members.manage',
      ]);
      const otherRole = await accessRole(db, other.actor.context.workspaceId);
      const otherGroup = await db
        .insertInto('workspace_access_groups')
        .values({
          workspace_id: other.actor.context.workspaceId,
          kind: 'manual',
          name: 'Other tenant group',
          state: 'active',
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const input = {
        roleId: role.id,
        roleRevision: role.revision,
        subject: { kind: 'source' as const, sourceId: f.source.id },
        subjectRevision: f.source.revision,
        scope: { kind: 'workspace' as const },
      };
      expect(
        await refusal(
          async () =>
            await assignWorkspaceAccessGrant(f.dependencies, f.actor, {
              ...input,
              roleId: otherRole.id,
              roleRevision: otherRole.revision,
            }),
        ),
      ).toBe('WORKSPACE_ACCESS_ROLE_NOT_FOUND');
      expect(
        await refusal(
          async () =>
            await assignWorkspaceAccessGrant(f.dependencies, f.actor, {
              ...input,
              subject: { kind: 'source', sourceId: other.source.id },
              subjectRevision: other.source.revision,
            }),
        ),
      ).toBe('WORKSPACE_ACCESS_SOURCE_NOT_FOUND');
      expect(
        await refusal(
          async () =>
            await assignWorkspaceAccessGrant(f.dependencies, f.actor, {
              ...input,
              subject: { kind: 'group', groupId: otherGroup.id },
              subjectRevision: otherGroup.revision,
            }),
        ),
      ).toBe('WORKSPACE_ACCESS_GROUP_NOT_FOUND');
      expect(
        await refusal(
          async () =>
            await assignWorkspaceAccessGrant(f.dependencies, f.actor, {
              ...input,
              scope: { kind: 'channel', channelId: crypto.randomUUID() },
            }),
        ),
      ).toBe('CHANNEL_NOT_FOUND');
      const foreignGrant = await assignWorkspaceAccessGrant(other.dependencies, other.actor, {
        ...input,
        roleId: otherRole.id,
        roleRevision: otherRole.revision,
        subject: { kind: 'source', sourceId: other.source.id },
        subjectRevision: other.source.revision,
      });
      expect(
        await refusal(async () => {
          await revokeWorkspaceAccessGrant(f.dependencies, f.actor, foreignGrant.id, {
            revision: foreignGrant.revision,
          });
        }),
      ).toBe('WORKSPACE_ACCESS_GRANT_NOT_FOUND');
      expect((await listWorkspaceAccessGrants(f.dependencies, f.actor, {})).data).toEqual([]);
      expect(f.effects).toHaveLength(0);
      await db
        .updateTable('workspace_members')
        .set({
          access_kind: 'guest',
          guest_since: now,
          guest_expires_at: new Date(now.getTime() + 86_400_000),
          guest_modules: ['chat'],
        })
        .where('workspace_id', '=', f.actor.context.workspaceId)
        .where('user_id', '=', f.member.context.userId)
        .execute();
      expect(
        await refusal(async () => await assignWorkspaceAccessGrant(f.dependencies, f.actor, input)),
      ).toBe('WORKSPACE_ACCESS_SOURCE_NOT_FOUND');
    });
  });
});
