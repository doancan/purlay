/** Native lifecycle mutations preserve independent sources, sessions and the retained replay fence. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Transaction } from '@purlay/db';
import { fixedClock } from '../../../platform/clock';
import { AppError } from '../../../platform/errors';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { aSession } from '../../../testing/signed-in';
import { aUniqueSlug, aUserRow } from '../../../testing/users';
import { noWorkspaceChannels } from '../channels-port';
import {
  lockWorkspaceProvisioningSession,
  type WorkspaceProvisioningActor,
  type WorkspaceProvisioningDependencies,
} from './authority';
import { requireManualWorkspaceSource } from './native-state';
import { projectWorkspaceAccess } from './projection';
import {
  readWorkspaceMemberAccess,
  listWorkspaceAccessPeople,
  readWorkspaceAccessCohort,
} from './read-access';
import {
  createWorkspaceAccessRole,
  updateWorkspaceAccessRole,
  listWorkspaceAccessRoles,
} from './roles';
import {
  createWorkspaceAccessGroup,
  updateWorkspaceAccessGroup,
  retireWorkspaceAccessGroup,
  listWorkspaceAccessGroups,
} from './groups';
import { lockWorkspaceProjectionScope } from './scope';
import {
  addManualWorkspaceAccess,
  offboardWorkspaceMember,
  previewWorkspaceOffboarding,
  readmitWorkspaceMember,
  revokeWorkspaceAccessSource,
} from './source-offboarding';

afterAll(closeIntegrationDatabase);
const now = new Date('2026-11-12T18:00:00Z');
const clock = fixedClock(now);

const fixture = async (
  db: Transaction,
): Promise<{
  dependencies: WorkspaceProvisioningDependencies;
  actor: WorkspaceProvisioningActor;
  userId: string;
  globalSessionId: string;
  sourceId: string;
  sourceRevision: string;
}> => {
  const owner = await aUserRow(db, 'lifecycle-owner');
  const person = await aUserRow(db, 'lifecycle-person');
  const workspace = await db
    .insertInto('workspaces')
    .values({ name: 'Lifecycle', slug: aUniqueSlug('lifecycle') })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('workspace_members')
    .values([
      { workspace_id: workspace.id, user_id: owner.userId, role: 'owner' },
      { workspace_id: workspace.id, user_id: person.userId, role: 'member' },
    ])
    .execute();
  const ownerSession = await aSession(db, clock, owner.userId);
  const globalSession = await aSession(db, clock, person.userId);
  const actor = {
    context: await requireWorkspaceMembership(db, owner.userId, workspace.id),
    sessionId: ownerSession.sessionId,
  };
  const scope = await lockWorkspaceProjectionScope(db, workspace.id);
  await requireManualWorkspaceSource(db, clock, scope, owner.userId);
  const source = await requireManualWorkspaceSource(db, clock, scope, person.userId);
  return {
    actor,
    userId: person.userId,
    globalSessionId: globalSession.sessionId,
    sourceId: source.id,
    sourceRevision: source.revision,
    dependencies: {
      database: db,
      clock,
      lifetime: () => ({ sessionIdleTimeoutHours: null, sessionMaxAgeDays: null }),
      channels: noWorkspaceChannels,
      readersReady: () => Promise.resolve(true),
      afterCommit: (): void => undefined,
      bus: {
        publish: (): Promise<void> => Promise.reject(new Error('Rollback must not publish.')),
        subscribe: () => false,
        unsubscribe: (): void => undefined,
        forget: (): void => undefined,
      },
    },
  };
};

const codeOf = async (attempt: Promise<unknown>): Promise<string> => {
  try {
    await attempt;
    return 'taken';
  } catch (error) {
    if (error instanceof AppError) return error.body.code;
    throw error;
  }
};

const companyProof = async (
  db: Transaction,
  workspaceId: string,
  userId: string,
): Promise<string> => {
  const domain = await db
    .insertInto('workspace_identity_domains')
    .values({
      workspace_id: workspaceId,
      domain: `${crypto.randomUUID()}.test.invalid`,
      challenge_issued_at: now,
      challenge_expires_at: new Date(now.getTime() + 86_400_000),
      verified_at: now,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const revision = crypto.randomUUID();
  const connection = await db
    .insertInto('workspace_identity_connections')
    .values({
      workspace_id: workspaceId,
      domain_id: domain.id,
      name: 'Fixture identity',
      issuer: `https://${crypto.randomUUID()}.test.invalid`,
      client_id: 'fixture',
      client_secret_encrypted: Buffer.from('fixture'),
      authentication_revision: revision,
      tested_authentication_revision: revision,
      tested_at: now,
      enabled: true,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const binding = await db
    .insertInto('workspace_identity_bindings')
    .values({
      workspace_id: workspaceId,
      connection_id: connection.id,
      user_id: userId,
      issuer: connection.issuer,
      subject: userId,
      last_authenticated_at: now,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const session = await db
    .insertInto('sessions')
    .values({
      user_id: userId,
      token_hash: crypto.randomUUID(),
      company_workspace_id: workspaceId,
      created_at: now,
      last_used_at: now,
      expires_at: new Date(now.getTime() + 86_400_000),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('workspace_identity_sessions')
    .values({
      session_id: session.id,
      workspace_id: workspaceId,
      connection_id: connection.id,
      binding_reference: binding.id,
      authentication_revision: revision,
      authenticated_at: now,
    })
    .execute();
  return session.id;
};

describe('integration: retained source offboarding lifecycle', () => {
  test('full offboarding fences replay, retains configured states, and explicit readmission restores only active sources', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const workspaceId = f.actor.context.workspaceId;
      const sources = await db
        .insertInto('workspace_access_sources')
        .values(
          ['active', 'inactive'].map((state) => ({
            workspace_id: workspaceId,
            user_id: f.userId,
            kind: 'directory',
            directory_id: crypto.randomUUID(),
            directory_link_reference: crypto.randomUUID(),
            state,
            builtin_role: 'member' as const,
            access_kind: 'member',
            admitted_at: now,
            created_at: now,
            updated_at: now,
          })),
        )
        .returningAll()
        .execute();
      const current = await readWorkspaceMemberAccess(f.dependencies, f.actor, f.userId);
      const offboarded = await offboardWorkspaceMember(f.dependencies, f.actor, f.userId, {
        revision: current.revision,
        confirm: true,
      });
      expect(offboarded.state).toBe('offboarded');
      expect(offboarded.role).toBeNull();
      const after = await db
        .selectFrom('workspace_access_sources')
        .selectAll()
        .where('workspace_id', '=', workspaceId)
        .where('user_id', '=', f.userId)
        .execute();
      for (const before of sources) {
        const retained = after.find((source) => source.id === before.id);
        expect(retained?.state).toBe(before.state);
        expect(retained?.authorization_revision).not.toBe(before.authorization_revision);
      }
      expect(
        await codeOf(
          addManualWorkspaceAccess(f.dependencies, f.actor, f.userId, {
            revision: offboarded.revision,
            role: 'member',
          }),
        ),
      ).toBe('WORKSPACE_MEMBERSHIP_MANAGED');
      const scope = await lockWorkspaceProjectionScope(db, workspaceId);
      await projectWorkspaceAccess(db, clock, scope, [f.userId], noWorkspaceChannels);
      expect(
        await db
          .selectFrom('workspace_members')
          .select('id')
          .where('workspace_id', '=', workspaceId)
          .where('user_id', '=', f.userId)
          .execute(),
      ).toEqual([]);
      const replay = await readWorkspaceMemberAccess(f.dependencies, f.actor, f.userId);
      expect(
        await codeOf(
          readmitWorkspaceMember(f.dependencies, f.actor, f.userId, {
            revision: current.revision,
            confirm: true,
          }),
        ),
      ).toBe('WORKSPACE_PROVISIONING_CHANGED');
      const readmitted = await readmitWorkspaceMember(f.dependencies, f.actor, f.userId, {
        revision: replay.revision,
        confirm: true,
      });
      expect(readmitted.state).toBe('active');
      expect(readmitted.role).toBe('member');
      expect(
        readmitted.sources
          .filter((source) => source.kind === 'directory')
          .map((source) => source.state)
          .sort(),
      ).toEqual(['active', 'inactive']);
      expect(
        (
          await db
            .selectFrom('sessions')
            .select('revoked_at')
            .where('id', '=', f.globalSessionId)
            .executeTakeFirstOrThrow()
        ).revoked_at,
      ).toBeNull();
    });
  });

  test('source revocation preserves B and global authority, while manual company proof stays revoked after manual re-add', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const workspaceId = f.actor.context.workspaceId;
      const companyA = await companyProof(db, workspaceId, f.userId);
      const workspaceB = await db
        .insertInto('workspaces')
        .values({ name: 'Independent B', slug: aUniqueSlug('independent-b') })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: workspaceB.id, user_id: f.userId, role: 'owner' })
        .execute();
      const companyB = await companyProof(db, workspaceB.id, f.userId);
      const directory = await db
        .insertInto('workspace_access_sources')
        .values({
          workspace_id: workspaceId,
          user_id: f.userId,
          kind: 'directory',
          directory_id: crypto.randomUUID(),
          directory_link_reference: crypto.randomUUID(),
          state: 'active',
          builtin_role: 'member',
          access_kind: 'member',
          admitted_at: now,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const fromDirectory = await revokeWorkspaceAccessSource(
        f.dependencies,
        f.actor,
        f.userId,
        directory.id,
        { revision: directory.revision },
      );
      expect(fromDirectory.state).toBe('active');
      expect(
        (
          await db
            .selectFrom('workspace_identity_sessions')
            .select('revoked_at')
            .where('session_id', '=', companyA)
            .executeTakeFirstOrThrow()
        ).revoked_at,
      ).toBeNull();
      const fromManual = await revokeWorkspaceAccessSource(
        f.dependencies,
        f.actor,
        f.userId,
        f.sourceId,
        { revision: f.sourceRevision },
      );
      expect(fromManual.state).toBe('inactive');
      expect(
        (
          await db
            .selectFrom('workspace_identity_sessions')
            .select('revoked_at')
            .where('session_id', '=', companyA)
            .executeTakeFirstOrThrow()
        ).revoked_at,
      ).not.toBeNull();
      const added = await addManualWorkspaceAccess(f.dependencies, f.actor, f.userId, {
        revision: fromManual.revision,
        role: 'member',
      });
      expect(added.state).toBe('active');
      expect(
        (
          await db
            .selectFrom('workspace_identity_sessions')
            .select('revoked_at')
            .where('session_id', '=', companyA)
            .executeTakeFirstOrThrow()
        ).revoked_at,
      ).not.toBeNull();
      expect(
        (
          await db
            .selectFrom('workspace_identity_sessions')
            .select('revoked_at')
            .where('session_id', '=', companyB)
            .executeTakeFirstOrThrow()
        ).revoked_at,
      ).toBeNull();
      expect(
        (
          await db
            .selectFrom('sessions')
            .select('revoked_at')
            .where('id', '=', f.globalSessionId)
            .executeTakeFirstOrThrow()
        ).revoked_at,
      ).toBeNull();
      expect(
        (
          await db
            .selectFrom('workspace_members')
            .select('role')
            .where('workspace_id', '=', workspaceB.id)
            .where('user_id', '=', f.userId)
            .executeTakeFirstOrThrow()
        ).role,
      ).toBe('owner');
      const ownerAccess = await readWorkspaceMemberAccess(
        f.dependencies,
        f.actor,
        f.actor.context.userId,
      );
      const preview = await previewWorkspaceOffboarding(
        f.dependencies,
        f.actor,
        f.actor.context.userId,
        { revision: ownerAccess.revision },
      );
      expect(preview).toMatchObject({
        canOffboard: false,
        reason: 'last_owner',
        affectedChannelCount: 0,
        sourceSessionCount: 0,
      });
      expect(
        await codeOf(
          offboardWorkspaceMember(f.dependencies, f.actor, f.actor.context.userId, {
            revision: ownerAccess.revision,
            confirm: true,
          }),
        ),
      ).toBe('LAST_OWNER');
    });
  });
});

describe('integration: administration rejects stale and unavailable authority', () => {
  test('role/group definitions keep literal search, unique names, no-op revisions and terminal retirement', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const unavailable = {
        ...f.dependencies,
        readersReady: (): Promise<boolean> => Promise.resolve(false),
      };
      expect(
        await codeOf(
          createWorkspaceAccessRole(unavailable, f.actor, {
            name: 'Blocked',
            capabilities: ['audit.read'],
          }),
        ),
      ).toBe('WORKSPACE_PROVISIONING_NOT_READY');
      expect(
        await codeOf(
          createWorkspaceAccessRole(
            {
              ...f.dependencies,
              readersReady: (): Promise<boolean> =>
                Promise.reject(new Error('Peer status unavailable')),
            },
            f.actor,
            { name: 'Blocked', capabilities: ['audit.read'] },
          ),
        ),
      ).toBe('WORKSPACE_PROVISIONING_NOT_READY');
      expect(
        await codeOf(
          createWorkspaceAccessRole(f.dependencies, f.actor, {
            name: ' ',
            capabilities: ['audit.read'],
          }),
        ),
      ).toBe('VALIDATION_FAILED');
      const role = await createWorkspaceAccessRole(f.dependencies, f.actor, {
        name: 'Unique role',
        capabilities: ['audit.read'],
      });
      expect(
        await codeOf(
          createWorkspaceAccessRole(f.dependencies, f.actor, {
            name: 'UNIQUE ROLE',
            capabilities: ['audit.read'],
          }),
        ),
      ).toBe('VALIDATION_FAILED');
      expect(
        (
          await updateWorkspaceAccessRole(f.dependencies, f.actor, role.id, {
            revision: role.revision,
            name: role.name,
            capabilities: ['audit.read'],
          })
        ).revision,
      ).toBe(role.revision);
      expect(
        (await listWorkspaceAccessRoles(f.dependencies, f.actor, { q: 'Unique role' })).data.map(
          (r) => r.id,
        ),
      ).toEqual([role.id]);
      expect(
        await codeOf(
          updateWorkspaceAccessRole(f.dependencies, f.actor, crypto.randomUUID(), {
            revision: role.revision,
            name: 'Missing',
          }),
        ),
      ).toBe('WORKSPACE_ACCESS_ROLE_NOT_FOUND');
      const group = await createWorkspaceAccessGroup(f.dependencies, f.actor, {
        name: 'Unique group',
      });
      expect(
        await codeOf(createWorkspaceAccessGroup(f.dependencies, f.actor, { name: 'UNIQUE GROUP' })),
      ).toBe('VALIDATION_FAILED');
      expect(
        (await listWorkspaceAccessGroups(f.dependencies, f.actor, { q: 'Unique group' })).data.map(
          (r) => r.id,
        ),
      ).toEqual([group.id]);
      await retireWorkspaceAccessGroup(f.dependencies, f.actor, group.id, {
        revision: group.revision,
      });
      expect(
        await codeOf(
          updateWorkspaceAccessGroup(f.dependencies, f.actor, group.id, {
            revision: group.revision,
            name: 'Revived',
          }),
        ),
      ).toBe('WORKSPACE_ACCESS_GROUP_NOT_FOUND');
      expect((await listWorkspaceAccessGroups(f.dependencies, f.actor, {})).data).toEqual([]);
      const { afterCommit: registrar, ...unowned } = f.dependencies;
      expect(registrar).toBeDefined();
      let rejected = false;
      try {
        await createWorkspaceAccessGroup(unowned, f.actor, { name: 'Unowned transaction' });
      } catch (error) {
        rejected = error instanceof Error && error.message.includes('after-commit registrar');
      }
      expect(rejected).toBe(true);
    });
  });
  test('native caller locks cannot borrow another session and suspension removes live administrative authority', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      await lockWorkspaceProvisioningSession(db, f.dependencies, f.actor);
      expect(
        await codeOf(
          lockWorkspaceProvisioningSession(db, f.dependencies, {
            ...f.actor,
            sessionId: f.globalSessionId,
          }),
        ),
      ).toBe('UNAUTHENTICATED');
      await db
        .updateTable('users')
        .set({ suspended_at: now })
        .where('id', '=', f.actor.context.userId)
        .execute();
      expect(await codeOf(listWorkspaceAccessRoles(f.dependencies, f.actor, {}))).toBe(
        'UNAUTHENTICATED',
      );
      await db
        .updateTable('users')
        .set({ suspended_at: null })
        .where('id', '=', f.actor.context.userId)
        .execute();
      expect((await listWorkspaceAccessRoles(f.dependencies, f.actor, {})).data).toEqual([]);
      expect(
        await codeOf(readWorkspaceMemberAccess(f.dependencies, f.actor, crypto.randomUUID())),
      ).toBe('USER_NOT_FOUND');
      expect(
        (
          await listWorkspaceAccessPeople(f.dependencies, f.actor, {
            state: 'active',
            q: 'lifecycle-person',
          })
        ).data.map((r) => r.user.id),
      ).toEqual([f.userId]);
      const scope = await lockWorkspaceProjectionScope(db, f.actor.context.workspaceId);
      expect((await readWorkspaceAccessCohort(db, clock, scope, [])).size).toBe(0);
      let bounded = false;
      try {
        await readWorkspaceAccessCohort(
          db,
          clock,
          scope,
          Array.from({ length: 101 }, () => crypto.randomUUID()),
        );
      } catch (error) {
        bounded = error instanceof Error && error.message.includes('bounded page');
      }
      expect(bounded).toBe(true);
    });
  });
  test('explicit new manual admission cannot revive retired source identity and inactive retries stay quiet', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      await db
        .updateTable('workspace_access_sources')
        .set({
          state: 'retired',
          retired_at: now,
          revision: crypto.randomUUID(),
          authorization_revision: crypto.randomUUID(),
        })
        .where('id', '=', f.sourceId)
        .execute();
      const old = await readWorkspaceMemberAccess(f.dependencies, f.actor, f.userId);
      const admitted = await addManualWorkspaceAccess(f.dependencies, f.actor, f.userId, {
        revision: old.revision,
        role: 'member',
      });
      const current = admitted.sources.find((r) => r.state === 'active');
      if (current === undefined) throw new Error('Missing explicit manual admission.');
      expect(current.id).not.toBe(f.sourceId);
      const revoked = await revokeWorkspaceAccessSource(
        f.dependencies,
        f.actor,
        f.userId,
        current.id,
        { revision: current.revision },
      );
      const inactive = revoked.sources.find((r) => r.id === current.id);
      if (inactive === undefined) throw new Error('Missing retained inactive source.');
      const quiet = await revokeWorkspaceAccessSource(
        f.dependencies,
        f.actor,
        f.userId,
        current.id,
        { revision: inactive.revision },
      );
      expect(quiet.revision).toBe(revoked.revision);
      expect(
        (
          await db
            .selectFrom('workspace_access_sources')
            .select('state')
            .where('id', '=', f.sourceId)
            .executeTakeFirstOrThrow()
        ).state,
      ).toBe('retired');
      expect(
        (
          await db
            .selectFrom('sessions')
            .select('revoked_at')
            .where('id', '=', f.globalSessionId)
            .executeTakeFirstOrThrow()
        ).revoked_at,
      ).toBeNull();
    });
  });
  test('an owner can revoke only their own source while another genuine native owner remains', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const second = await aUserRow(db, 'second-native-owner');
      await db
        .insertInto('workspace_members')
        .values({
          workspace_id: f.actor.context.workspaceId,
          user_id: second.userId,
          role: 'owner',
        })
        .execute();
      const access = await readWorkspaceMemberAccess(
        f.dependencies,
        f.actor,
        f.actor.context.userId,
      );
      const source = access.sources.find((r) => r.state === 'active');
      if (source === undefined) throw new Error('Missing owner source.');
      const result = await revokeWorkspaceAccessSource(
        f.dependencies,
        f.actor,
        f.actor.context.userId,
        source.id,
        { revision: source.revision },
      );
      expect(result.state).toBe('inactive');
      expect(
        (
          await db
            .selectFrom('workspace_members')
            .select('role')
            .where('workspace_id', '=', f.actor.context.workspaceId)
            .where('user_id', '=', second.userId)
            .executeTakeFirstOrThrow()
        ).role,
      ).toBe('owner');
    });
  });
});
