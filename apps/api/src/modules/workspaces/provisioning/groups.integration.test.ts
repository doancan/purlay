/** Real SQL covers bounded first-use candidates and independent source contributions to a group. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, DROP_HOOK_MS, withRollback, type Transaction } from '@purlay/db';
import { fixedClock } from '../../../platform/clock';
import { AppError } from '../../../platform/errors';
import type { ErrorCode } from '@purlay/types';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { aRecordingLogger } from '../../../testing/doubles';
import { aSession } from '../../../testing/signed-in';
import { aUserRow, aUniqueSlug } from '../../../testing/users';
import { noWorkspaceChannels } from '../channels-port';
import {
  requireWorkspaceCapabilityNow,
  type WorkspaceProvisioningActor,
  type WorkspaceProvisioningDependencies,
} from './authority';
import {
  createWorkspaceAccessGroup,
  listWorkspaceAccessGroups,
  retireWorkspaceAccessGroup,
  updateWorkspaceAccessGroup,
} from './groups';
import {
  listWorkspaceAccessGroupCandidates,
  listWorkspaceAccessGroupMembers,
  updateWorkspaceAccessGroupMembers,
} from './group-members';
import { reconcileDirectoryAccessGroup, retireDirectoryAccessGroup } from './directory-groups';
import { initializeWorkspaceAdmission } from './native-state';
import { projectWorkspaceAccess } from './projection';
import { lockWorkspaceProjectionScope, type WorkspaceProjectionScope } from './scope';

afterAll(closeIntegrationDatabase, DROP_HOOK_MS);
const now = new Date('2026-11-12T18:00:00Z');
const clock = fixedClock(now);

const failureCode = async (attempt: Promise<unknown>): Promise<ErrorCode | null> => {
  try {
    await attempt;
    return null;
  } catch (error) {
    if (error instanceof AppError) return error.body.code;
    throw error;
  }
};

const fixture = async (
  db: Transaction,
): Promise<{
  workspaceId: string;
  actor: WorkspaceProvisioningActor;
  dependencies: WorkspaceProvisioningDependencies;
  scope: WorkspaceProjectionScope;
}> => {
  const owner = await aUserRow(db, 'group-owner');
  const workspace = await db
    .insertInto('workspaces')
    .values({ name: 'Groups', slug: aUniqueSlug('groups') })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('workspace_members')
    .values({ workspace_id: workspace.id, user_id: owner.userId, role: 'owner', joined_at: now })
    .execute();
  const session = await aSession(db, clock, owner.userId);
  const log = aRecordingLogger().log;
  const effects: (() => Promise<void>)[] = [];
  const dependencies: WorkspaceProvisioningDependencies = {
    database: db,
    clock,
    lifetime: () => ({ sessionIdleTimeoutHours: null, sessionMaxAgeDays: null }),
    channels: noWorkspaceChannels,
    bus: {
      publish: () => Promise.reject(new Error('A rolled-back native transaction must not publish')),
      subscribe: () => false,
      unsubscribe: () => undefined,
      forget: () => undefined,
    },
    log,
    readersReady: () => Promise.resolve(true),
    afterCommit: (transaction, effect): void => {
      if (transaction !== db) throw new Error('A callback borrowed another native transaction');
      effects.push(effect);
    },
  };
  const context = await requireWorkspaceMembership(db, owner.userId, workspace.id);
  return {
    workspaceId: workspace.id,
    actor: { context, sessionId: session.sessionId },
    dependencies,
    scope: await lockWorkspaceProjectionScope(db, workspace.id),
  };
};

describe('integration: source-aware access groups', () => {
  test('composite keyset visits every legacy candidate once while initializing only a bounded page', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const people = Array.from({ length: 130 }, (_, index) => ({
        id: crypto.randomUUID(),
        username: crypto.randomUUID(),
        display_name: `candidate-person ${String(index)}`,
        email: `${crypto.randomUUID()}@test.invalid`,
      }));
      await db.insertInto('users').values(people).execute();
      await db
        .insertInto('workspace_members')
        .values(
          people.map((person) => ({
            workspace_id: f.workspaceId,
            user_id: person.id,
            role: 'member' as const,
            joined_at: now,
          })),
        )
        .execute();
      const group = await createWorkspaceAccessGroup(f.dependencies, f.actor, { name: 'Finance' });
      const first = await listWorkspaceAccessGroupCandidates(f.dependencies, f.actor, group.id, {
        q: 'candidate-person',
        limit: 7,
      });
      expect(first.data).toHaveLength(7);
      expect(first.nextCursor).toMatch(/^[0-9a-f-]{36}:[0-9a-f-]{36}$/);
      const initialized = await db
        .selectFrom('workspace_admission_controls')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('workspace_id', '=', f.workspaceId)
        .executeTakeFirstOrThrow();
      expect(Number(initialized.count)).toBe(7);
      const all = [...first.data];
      let before = first.nextCursor;
      let pages = 1;
      while (before !== null) {
        if (++pages > 20) throw new Error('Candidate cursor did not terminate');
        const next = await listWorkspaceAccessGroupCandidates(f.dependencies, f.actor, group.id, {
          q: 'candidate-person',
          limit: 7,
          before,
        });
        expect(next.data.length).toBeLessThanOrEqual(7);
        all.push(...next.data);
        before = next.nextCursor;
      }
      expect(all).toHaveLength(130);
      expect(new Set(all.map((row) => row.user.id)).size).toBe(130);
      expect(new Set(all.map((row) => row.source.id)).size).toBe(130);
      const chosen = all[0];
      if (chosen === undefined) throw new Error('Missing candidate');
      const changed = await updateWorkspaceAccessGroupMembers(f.dependencies, f.actor, group.id, {
        revision: group.revision,
        addSourceIds: [chosen.source.id],
      });
      expect(changed.memberCount).toBe(1);
      const search = await listWorkspaceAccessGroupCandidates(f.dependencies, f.actor, group.id, {
        q: chosen.user.username,
      });
      expect(search.data).toEqual([]);
      expect(
        await failureCode(
          listWorkspaceAccessGroupCandidates(f.dependencies, f.actor, group.id, { before: 'bad' }),
        ),
      ).toBe('VALIDATION_FAILED');
    });
  });

  test('two sources count one person and removing one contribution preserves the other capability', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const person = await aUserRow(db, 'group-person');
      await db
        .insertInto('workspace_members')
        .values({
          workspace_id: f.workspaceId,
          user_id: person.userId,
          role: 'member',
          joined_at: now,
        })
        .execute();
      await initializeWorkspaceAdmission(db, clock, f.scope, person.userId);
      const directory = crypto.randomUUID();
      const source = await db
        .insertInto('workspace_access_sources')
        .values({
          workspace_id: f.workspaceId,
          user_id: person.userId,
          kind: 'directory',
          directory_id: directory,
          directory_link_reference: crypto.randomUUID(),
          state: 'active',
          builtin_role: 'member',
          access_kind: 'member',
          admitted_at: now,
          created_at: now,
          updated_at: now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const manual = await db
        .selectFrom('workspace_access_sources')
        .select('id')
        .where('workspace_id', '=', f.workspaceId)
        .where('user_id', '=', person.userId)
        .where('kind', '=', 'manual')
        .executeTakeFirstOrThrow();
      const group = await createWorkspaceAccessGroup(f.dependencies, f.actor, { name: 'Readers' });
      const populated = await updateWorkspaceAccessGroupMembers(f.dependencies, f.actor, group.id, {
        revision: group.revision,
        addSourceIds: [manual.id, source.id],
      });
      expect(populated.memberCount).toBe(1);
      const members = await listWorkspaceAccessGroupMembers(f.dependencies, f.actor, group.id, {});
      expect(members.data).toHaveLength(2);
      expect(new Set(members.data.map((row) => row.source.id))).toEqual(
        new Set([manual.id, source.id]),
      );
      const role = await db
        .insertInto('workspace_access_roles')
        .values({
          workspace_id: f.workspaceId,
          name: 'Group audit',
          capabilities: ['audit.read'],
          created_at: now,
          updated_at: now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('workspace_access_role_grants')
        .values({
          workspace_id: f.workspaceId,
          role_id: role.id,
          group_id: group.id,
          created_at: now,
        })
        .execute();
      await projectWorkspaceAccess(db, clock, f.scope, [person.userId], noWorkspaceChannels);
      const context = await requireWorkspaceMembership(db, person.userId, f.workspaceId);
      await requireWorkspaceCapabilityNow(db, context, 'audit.read');
      const remaining = await updateWorkspaceAccessGroupMembers(f.dependencies, f.actor, group.id, {
        revision: populated.revision,
        removeSourceIds: [manual.id],
      });
      expect(remaining.memberCount).toBe(1);
      await requireWorkspaceCapabilityNow(db, context, 'audit.read');
      expect(
        await failureCode(
          updateWorkspaceAccessGroupMembers(f.dependencies, f.actor, group.id, {
            revision: populated.revision,
            removeSourceIds: [source.id],
          }),
        ),
      ).toBe('WORKSPACE_PROVISIONING_CHANGED');
      await updateWorkspaceAccessGroupMembers(f.dependencies, f.actor, group.id, {
        revision: remaining.revision,
        removeSourceIds: [source.id],
      });
      expect(await failureCode(requireWorkspaceCapabilityNow(db, context, 'audit.read'))).toBe(
        'FORBIDDEN',
      );
      expect(
        await db
          .selectFrom('workspace_members')
          .select('role')
          .where('workspace_id', '=', f.workspaceId)
          .where('user_id', '=', person.userId)
          .executeTakeFirst(),
      ).toMatchObject({ role: 'member' });
    });
  });

  test('native directory groups use exact source ownership, stay read-only locally and cannot replay after retirement', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const person = await aUserRow(db, 'directory-person');
      await initializeWorkspaceAdmission(db, clock, f.scope, person.userId);
      const directory = crypto.randomUUID();
      const source = await db
        .insertInto('workspace_access_sources')
        .values({
          workspace_id: f.workspaceId,
          user_id: person.userId,
          kind: 'directory',
          directory_id: directory,
          directory_link_reference: crypto.randomUUID(),
          state: 'active',
          builtin_role: 'member',
          access_kind: 'member',
          admitted_at: now,
          created_at: now,
          updated_at: now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await projectWorkspaceAccess(db, clock, f.scope, [person.userId], noWorkspaceChannels);
      const reference = crypto.randomUUID();
      const input = {
        directoryId: directory,
        directoryGroupReference: reference,
        name: 'Directory people',
        sourceIds: [source.id],
        active: true,
      };
      expect(
        await failureCode(
          reconcileDirectoryAccessGroup(db, f.dependencies, f.scope, {
            ...input,
            directoryId: crypto.randomUUID(),
          }),
        ),
      ).toBe('WORKSPACE_ACCESS_SOURCE_NOT_FOUND');
      const created = await reconcileDirectoryAccessGroup(db, f.dependencies, f.scope, input);
      expect(created.affectedUserIds).toEqual([person.userId]);
      expect(
        (await reconcileDirectoryAccessGroup(db, f.dependencies, f.scope, input)).affectedUserIds,
      ).toEqual([]);
      const group = (await listWorkspaceAccessGroups(f.dependencies, f.actor, {})).data.find(
        (row) => row.id === created.groupId,
      );
      if (group === undefined) throw new Error('Missing directory group');
      expect(group).toMatchObject({ kind: 'directory', directoryId: directory, memberCount: 1 });
      expect(
        await failureCode(
          updateWorkspaceAccessGroup(f.dependencies, f.actor, group.id, {
            revision: group.revision,
            name: 'Local takeover',
          }),
        ),
      ).toBe('WORKSPACE_MEMBERSHIP_MANAGED');
      expect(
        await failureCode(
          retireWorkspaceAccessGroup(f.dependencies, f.actor, group.id, {
            revision: group.revision,
          }),
        ),
      ).toBe('WORKSPACE_MEMBERSHIP_MANAGED');
      expect(
        (
          await reconcileDirectoryAccessGroup(db, f.dependencies, f.scope, {
            ...input,
            active: false,
          })
        ).affectedUserIds,
      ).toEqual([person.userId]);
      expect(
        (await reconcileDirectoryAccessGroup(db, f.dependencies, f.scope, input)).affectedUserIds,
      ).toEqual([person.userId]);
      expect(await retireDirectoryAccessGroup(db, f.dependencies, f.scope, input)).toEqual([
        person.userId,
      ]);
      expect(await retireDirectoryAccessGroup(db, f.dependencies, f.scope, input)).toEqual([]);
      expect(
        await failureCode(reconcileDirectoryAccessGroup(db, f.dependencies, f.scope, input)),
      ).toBe('WORKSPACE_ACCESS_GROUP_NOT_FOUND');
      expect((await listWorkspaceAccessGroups(f.dependencies, f.actor, {})).data).toEqual([]);
    });
  });
});
