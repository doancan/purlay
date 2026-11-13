/** Actual native rows distinguish faithful manual admission from directory projection and replay. */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  closeIntegrationDatabase,
  DROP_HOOK_MS,
  sql,
  withRollback,
  type Transaction,
} from '@purlay/db';
import { fixedClock } from '../../../platform/clock';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { noWorkspaceChannels } from '../channels-port';
import { requireWorkspaceCapabilityNow } from './authority';
import { reconcileDirectoryWorkspaceSource } from './directory-sources';
import { WORKSPACE_ACCESS_SOURCES_MAX } from '@purlay/types/workspace-provisioning';
import { initializeWorkspaceAdmission, requireManualWorkspaceSource } from './native-state';
import { projectWorkspaceAccess } from './projection';
import { lockWorkspaceProjectionScope, type WorkspaceProjectionScope } from './scope';

const now = new Date('2026-11-12T18:00:00Z');
const clock = fixedClock(now);
const rejected = async (promise: Promise<unknown>): Promise<unknown> =>
  await promise.then(
    () => {
      throw new Error('Expected this operation to be refused.');
    },
    (error: unknown): unknown => error,
  );

afterAll(closeIntegrationDatabase, DROP_HOOK_MS);

const fixture = async (
  db: Transaction,
): Promise<{
  workspaceId: string;
  ownerId: string;
  personId: string;
  privateWorkspaceId: string;
  scope: WorkspaceProjectionScope;
}> => {
  const [ownerId, personId] = [crypto.randomUUID(), crypto.randomUUID()];
  await db
    .insertInto('users')
    .values(
      [ownerId, personId].map((id) => ({
        id,
        email: `${id}@test.invalid`,
        username: id,
        display_name: id,
      })),
    )
    .execute();
  const [workspaceId, privateWorkspaceId] = [crypto.randomUUID(), crypto.randomUUID()];
  await db
    .insertInto('workspaces')
    .values([workspaceId, privateWorkspaceId].map((id) => ({ id, name: id, slug: id })))
    .execute();
  await db
    .insertInto('workspace_members')
    .values([
      { workspace_id: workspaceId, user_id: ownerId, role: 'owner', joined_at: now },
      { workspace_id: privateWorkspaceId, user_id: personId, role: 'owner', joined_at: now },
    ])
    .execute();
  const scope = await lockWorkspaceProjectionScope(db, workspaceId);
  await initializeWorkspaceAdmission(db, clock, scope, ownerId);
  return { workspaceId, ownerId, personId, privateWorkspaceId, scope };
};

const directorySource = async (
  db: Transaction,
  scope: WorkspaceProjectionScope,
  userId: string,
): Promise<string> => {
  await initializeWorkspaceAdmission(db, clock, scope, userId);
  const source = await db
    .insertInto('workspace_access_sources')
    .values({
      workspace_id: scope.workspaceId,
      user_id: userId,
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
    .returning('id')
    .executeTakeFirstOrThrow();
  return source.id;
};

const disable = async (db: Transaction, sourceId: string): Promise<void> => {
  await db
    .updateTable('workspace_access_sources')
    .set({
      state: 'inactive',
      revision: crypto.randomUUID(),
      authorization_revision: crypto.randomUUID(),
      updated_at: now,
    })
    .where('id', '=', sourceId)
    .execute();
};

describe.skipIf(process.env['DATABASE_URL'] === undefined)(
  'integration: native source projection',
  () => {
    test('faithful initialization runs once; a projected native row never becomes manual admission', async () => {
      await withRollback(async (db) => {
        const f = await fixture(db);
        const sourceId = await directorySource(db, f.scope, f.personId);
        await projectWorkspaceAccess(db, clock, f.scope, [f.personId], noWorkspaceChannels);
        const first = await initializeWorkspaceAdmission(db, clock, f.scope, f.personId);
        const again = await initializeWorkspaceAdmission(db, clock, f.scope, f.personId);
        expect(again.revision).toBe(first.revision);
        expect(
          await db
            .selectFrom('workspace_access_sources')
            .select('id')
            .where('workspace_id', '=', f.workspaceId)
            .where('user_id', '=', f.personId)
            .where('kind', '=', 'manual')
            .execute(),
        ).toHaveLength(0);
        expect(
          await rejected(requireManualWorkspaceSource(db, clock, f.scope, f.personId)),
        ).toMatchObject({ body: { code: 'WORKSPACE_MEMBERSHIP_MANAGED' } });
        await disable(db, sourceId);
        await projectWorkspaceAccess(db, clock, f.scope, [f.personId], noWorkspaceChannels);
        expect(
          await db
            .selectFrom('workspace_members')
            .select('id')
            .where('workspace_id', '=', f.workspaceId)
            .where('user_id', '=', f.personId)
            .executeTakeFirst(),
        ).toBeUndefined();
        // Even an erroneous stale native row cannot re-seed a manual source at the next projection.
        await db
          .insertInto('workspace_members')
          .values({ workspace_id: f.workspaceId, user_id: f.personId })
          .execute();
        await initializeWorkspaceAdmission(db, clock, f.scope, f.personId);
        await projectWorkspaceAccess(db, clock, f.scope, [f.personId], noWorkspaceChannels);
        expect(
          await db
            .selectFrom('workspace_members')
            .select('id')
            .where('workspace_id', '=', f.workspaceId)
            .where('user_id', '=', f.personId)
            .executeTakeFirst(),
        ).toBeUndefined();
        expect(
          await db
            .selectFrom('workspace_access_sources')
            .select('id')
            .where('workspace_id', '=', f.workspaceId)
            .where('user_id', '=', f.personId)
            .where('kind', '=', 'manual')
            .execute(),
        ).toHaveLength(0);
      });
    });

    test('A removal preserves B and the independent private workspace; last source removal affects only A workspace', async () => {
      await withRollback(async (db) => {
        const f = await fixture(db);
        const [a, b] = [
          await directorySource(db, f.scope, f.personId),
          await directorySource(db, f.scope, f.personId),
        ];
        await projectWorkspaceAccess(db, clock, f.scope, [f.personId], noWorkspaceChannels);
        const native = await db
          .selectFrom('workspace_members')
          .select(['id', 'joined_at'])
          .where('workspace_id', '=', f.workspaceId)
          .where('user_id', '=', f.personId)
          .executeTakeFirstOrThrow();
        await disable(db, a);
        await projectWorkspaceAccess(db, clock, f.scope, [f.personId], noWorkspaceChannels);
        expect(
          await db
            .selectFrom('workspace_members')
            .select(['id', 'joined_at'])
            .where('workspace_id', '=', f.workspaceId)
            .where('user_id', '=', f.personId)
            .executeTakeFirstOrThrow(),
        ).toEqual(native);
        await disable(db, b);
        await projectWorkspaceAccess(db, clock, f.scope, [f.personId], noWorkspaceChannels);
        expect(
          await db
            .selectFrom('workspace_members')
            .select('id')
            .where('workspace_id', '=', f.workspaceId)
            .where('user_id', '=', f.personId)
            .executeTakeFirst(),
        ).toBeUndefined();
        expect(
          (
            await db
              .selectFrom('workspace_members')
              .select('role')
              .where('workspace_id', '=', f.privateWorkspaceId)
              .where('user_id', '=', f.personId)
              .executeTakeFirstOrThrow()
          ).role,
        ).toBe('owner');
        expect(
          await db
            .selectFrom('users')
            .select(['deleted_at', 'suspended_at'])
            .where('id', '=', f.personId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ deleted_at: null, suspended_at: null });
      });
    });

    test('manual role and join time survive a directory source disappearing', async () => {
      await withRollback(async (db) => {
        const f = await fixture(db);
        const joined = new Date('2026-10-01T09:00:00Z');
        await db
          .insertInto('workspace_members')
          .values({
            workspace_id: f.workspaceId,
            user_id: f.personId,
            role: 'admin',
            joined_at: joined,
          })
          .execute();
        const sourceId = await directorySource(db, f.scope, f.personId);
        await disable(db, sourceId);
        await projectWorkspaceAccess(db, clock, f.scope, [f.personId], noWorkspaceChannels);
        expect(
          await db
            .selectFrom('workspace_members')
            .select(['role', 'joined_at'])
            .where('workspace_id', '=', f.workspaceId)
            .where('user_id', '=', f.personId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ role: 'admin', joined_at: joined });
        expect(
          (await requireManualWorkspaceSource(db, clock, f.scope, f.personId)).builtin_role,
        ).toBe('admin');
      });
    });

    test('source and group capabilities project only live exact contributions and never create admission', async () => {
      await withRollback(async (db) => {
        const f = await fixture(db);
        const [a, b] = [
          await directorySource(db, f.scope, f.personId),
          await directorySource(db, f.scope, f.personId),
        ];
        const role = await db
          .insertInto('workspace_access_roles')
          .values({
            workspace_id: f.workspaceId,
            name: 'Member helper',
            capabilities: ['members.invite', 'channel.members.manage'],
            created_at: now,
            updated_at: now,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const group = await db
          .insertInto('workspace_access_groups')
          .values({
            workspace_id: f.workspaceId,
            kind: 'manual',
            name: 'Helpers',
            state: 'active',
            created_at: now,
            updated_at: now,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await db
          .insertInto('workspace_access_group_members')
          .values({
            workspace_id: f.workspaceId,
            group_id: group.id,
            user_id: f.personId,
            source_id: b,
            created_at: now,
          })
          .execute();
        await db
          .insertInto('workspace_access_role_grants')
          .values([
            { workspace_id: f.workspaceId, role_id: role.id, source_id: a, created_at: now },
            { workspace_id: f.workspaceId, role_id: role.id, group_id: group.id, created_at: now },
          ])
          .execute();
        await projectWorkspaceAccess(db, clock, f.scope, [f.personId], noWorkspaceChannels);
        const context = await requireWorkspaceMembership(db, f.personId, f.workspaceId);
        await requireWorkspaceCapabilityNow(db, context, 'members.invite');
        expect(
          (
            await db
              .selectFrom('workspace_members')
              .select('role')
              .where('workspace_id', '=', f.workspaceId)
              .where('user_id', '=', f.personId)
              .executeTakeFirstOrThrow()
          ).role,
        ).toBe('member');
        expect(
          await db
            .selectFrom('workspace_member_capabilities')
            .select('capability')
            .where('workspace_id', '=', f.workspaceId)
            .where('user_id', '=', f.personId)
            .execute(),
        ).toEqual([{ capability: 'members.invite' }]);
        await disable(db, a);
        await projectWorkspaceAccess(db, clock, f.scope, [f.personId], noWorkspaceChannels);
        await requireWorkspaceCapabilityNow(db, context, 'members.invite');
        await db
          .deleteFrom('workspace_access_group_members')
          .where('workspace_id', '=', f.workspaceId)
          .where('group_id', '=', group.id)
          .execute();
        await projectWorkspaceAccess(db, clock, f.scope, [f.personId], noWorkspaceChannels);
        expect(
          await rejected(requireWorkspaceCapabilityNow(db, context, 'members.invite')),
        ).toMatchObject({ body: { code: 'FORBIDDEN' } });
        expect(
          await db
            .selectFrom('workspace_access_sources')
            .select('id')
            .where('workspace_id', '=', f.workspaceId)
            .where('user_id', '=', f.personId)
            .where('kind', '=', 'manual')
            .execute(),
        ).toHaveLength(0);
      });
    });

    test('local offboarding survives active provider replay and retains the original source initialization', async () => {
      await withRollback(async (db) => {
        const f = await fixture(db);
        const sourceId = await directorySource(db, f.scope, f.personId);
        await projectWorkspaceAccess(db, clock, f.scope, [f.personId], noWorkspaceChannels);
        const original = await initializeWorkspaceAdmission(db, clock, f.scope, f.personId);
        await db
          .updateTable('workspace_admission_controls')
          .set({ blocked_at: now, revision: crypto.randomUUID(), updated_at: now })
          .where('workspace_id', '=', f.workspaceId)
          .where('user_id', '=', f.personId)
          .execute();
        await db
          .updateTable('workspace_access_sources')
          .set({
            name: 'Provider replayed',
            revision: crypto.randomUUID(),
            authorization_revision: crypto.randomUUID(),
            updated_at: now,
          })
          .where('id', '=', sourceId)
          .execute();
        await projectWorkspaceAccess(db, clock, f.scope, [f.personId], noWorkspaceChannels);
        expect(
          await db
            .selectFrom('workspace_members')
            .select('id')
            .where('workspace_id', '=', f.workspaceId)
            .where('user_id', '=', f.personId)
            .executeTakeFirst(),
        ).toBeUndefined();
        const retained = await initializeWorkspaceAdmission(db, clock, f.scope, f.personId);
        expect(retained.initialized_at).toEqual(original.initialized_at);
        expect(retained.blocked_at).toEqual(now);
        expect(
          await rejected(requireManualWorkspaceSource(db, clock, f.scope, f.personId)),
        ).toMatchObject({ body: { code: 'WORKSPACE_MEMBERSHIP_MANAGED' } });
      });
    });

    test('a projection cannot remove the last live owner, and an aborted source change rolls back', async () => {
      await withRollback(async (db) => {
        const f = await fixture(db);
        const source = await requireManualWorkspaceSource(db, clock, f.scope, f.ownerId);
        await sql`savepoint last_owner_change`.execute(db);
        await disable(db, source.id);
        expect(
          await rejected(
            projectWorkspaceAccess(db, clock, f.scope, [f.ownerId], noWorkspaceChannels),
          ),
        ).toMatchObject({ body: { code: 'LAST_OWNER' } });
        await sql`rollback to savepoint last_owner_change`.execute(db);
        await sql`release savepoint last_owner_change`.execute(db);
        expect((await requireManualWorkspaceSource(db, clock, f.scope, f.ownerId)).state).toBe(
          'active',
        );
        expect(
          (
            await db
              .selectFrom('workspace_members')
              .select('role')
              .where('workspace_id', '=', f.workspaceId)
              .where('user_id', '=', f.ownerId)
              .executeTakeFirstOrThrow()
          ).role,
        ).toBe('owner');
      });
    });
  },
);

describe('integration: exact directory projection boundaries', () => {
  test('directory callbacks reject conflicting exact links, invalid labels, guest promotion and an unbounded source set', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const dependencies = { clock, channels: noWorkspaceChannels };
      const input = {
        directoryId: crypto.randomUUID(),
        directoryLinkReference: crypto.randomUUID(),
        userId: f.personId,
        active: true,
        name: 'Office source',
      };
      expect(
        await rejected(
          reconcileDirectoryWorkspaceSource(db, dependencies, f.scope, {
            ...input,
            name: ' padded ',
          }),
        ),
      ).toMatchObject({ body: { code: 'VALIDATION_FAILED' } });
      const first = await reconcileDirectoryWorkspaceSource(db, dependencies, f.scope, input);
      expect(
        await rejected(
          reconcileDirectoryWorkspaceSource(db, dependencies, f.scope, {
            ...input,
            directoryLinkReference: crypto.randomUUID(),
          }),
        ),
      ).toMatchObject({ body: { code: 'FORBIDDEN' } });
      for (let index = 1; index < WORKSPACE_ACCESS_SOURCES_MAX - 1; index += 1)
        await reconcileDirectoryWorkspaceSource(db, dependencies, f.scope, {
          ...input,
          directoryId: crypto.randomUUID(),
          directoryLinkReference: crypto.randomUUID(),
        });
      expect(
        await rejected(
          reconcileDirectoryWorkspaceSource(db, dependencies, f.scope, {
            ...input,
            directoryId: crypto.randomUUID(),
            directoryLinkReference: crypto.randomUUID(),
          }),
        ),
      ).toMatchObject({ body: { code: 'VALIDATION_FAILED' } });
      expect(
        await db
          .selectFrom('workspace_access_sources')
          .select('id')
          .where('user_id', '=', f.personId)
          .where('workspace_id', '=', f.workspaceId)
          .where('state', '=', 'active')
          .execute(),
      ).toHaveLength(WORKSPACE_ACCESS_SOURCES_MAX - 1);
      await db
        .updateTable('workspace_members')
        .set({ access_kind: 'guest', guest_since: now, guest_modules: ['chat'] })
        .where('workspace_id', '=', f.workspaceId)
        .where('user_id', '=', f.personId)
        .execute();
      expect(
        await rejected(reconcileDirectoryWorkspaceSource(db, dependencies, f.scope, input)),
      ).toMatchObject({ body: { code: 'FORBIDDEN' } });
      expect(
        (
          await db
            .selectFrom('workspace_access_sources')
            .select('authorization_revision')
            .where('id', '=', first.sourceId)
            .executeTakeFirstOrThrow()
        ).authorization_revision,
      ).toBe(first.authorizationRevision);
      expect(
        (
          await db
            .selectFrom('workspace_members')
            .select('role')
            .where('workspace_id', '=', f.privateWorkspaceId)
            .where('user_id', '=', f.personId)
            .executeTakeFirstOrThrow()
        ).role,
      ).toBe('owner');
    });
  });
});
