/** Source-specific revocation preserves independent access; a retained local block fences replay. */
import { sql, type Transaction } from '@purlay/db';
import type { UserRole } from '@purlay/types';
import type {
  AddManualWorkspaceAccessRequest,
  ConfirmWorkspaceOffboardingRequest,
  PreviewWorkspaceOffboardingRequest,
  ReadmitWorkspaceMemberRequest,
  RevokeWorkspaceAccessSourceRequest,
  WorkspaceMemberAccess,
  WorkspaceOffboardingPreview,
} from '@purlay/types/workspace-provisioning';
import type { Clock } from '../../../platform/clock';
import { AppError } from '../../../platform/errors';
import type { WorkspaceContext } from '../../../platform/tenancy';
import { recordAudit } from '../../audit/audit';
import { administerWorkspaceAccess } from './administration';
import {
  managedMembership,
  provisioningChanged,
  provisioningForbidden,
  sourceNotFound,
  type WorkspaceProvisioningActor,
  type WorkspaceProvisioningDependencies,
} from './authority';
import { initializeWorkspaceAdmission, type WorkspaceAdmissionControl } from './native-state';
import { projectWorkspaceAccess } from './projection';
import {
  memberAccessNotFound,
  readWorkspaceAccessCohort,
  requireRelatedWorkspacePerson,
} from './read-access';
import {
  noteCompanySessionsEnded,
  noteWorkspaceAccessChange,
  requireWorkspaceProjectionScope,
  type WorkspaceProjectionScope,
} from './scope';

const accessFor = async (
  transaction: Transaction,
  clock: Clock,
  scope: WorkspaceProjectionScope,
  userId: string,
): Promise<WorkspaceMemberAccess> => {
  const result = (await readWorkspaceAccessCohort(transaction, clock, scope, [userId])).get(userId);
  if (result === undefined) throw memberAccessNotFound();
  return result;
};

const controlFor = async (
  transaction: Transaction,
  clock: Clock,
  scope: WorkspaceProjectionScope,
  userId: string,
  revision: string,
): Promise<WorkspaceAdmissionControl> => {
  await requireRelatedWorkspacePerson(transaction, scope, userId);
  const control = await initializeWorkspaceAdmission(transaction, clock, scope, userId);
  if (control.revision !== revision) throw provisioningChanged();
  return control;
};

const targetRole = async (
  transaction: Transaction,
  scope: WorkspaceProjectionScope,
  userId: string,
  control: WorkspaceAdmissionControl,
): Promise<UserRole> =>
  (
    await transaction
      .selectFrom('workspace_members')
      .select('role')
      .where('workspace_id', '=', scope.workspaceId)
      .where('user_id', '=', userId)
      .executeTakeFirst()
  )?.role ?? control.last_builtin_role;

const protectTarget = (context: WorkspaceContext, role: UserRole, next?: UserRole): void => {
  if (context.role !== 'owner' && (role === 'owner' || next === 'owner'))
    throw provisioningForbidden();
};

const lastOwner = async (
  transaction: Transaction,
  scope: WorkspaceProjectionScope,
  userId: string,
): Promise<boolean> => {
  const other = await transaction
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .select('workspace_members.user_id')
    .where('workspace_members.workspace_id', '=', scope.workspaceId)
    .where('workspace_members.role', '=', 'owner')
    .where('workspace_members.user_id', '!=', userId)
    .where('users.deleted_at', 'is', null)
    .executeTakeFirst();
  return other === undefined;
};

const requireAnotherOwner = async (
  transaction: Transaction,
  scope: WorkspaceProjectionScope,
  userId: string,
): Promise<void> => {
  if (await lastOwner(transaction, scope, userId))
    throw new AppError({
      code: 'LAST_OWNER',
      message: 'A workspace keeps at least one owner: make somebody else an owner first.',
    });
};

/** Revokes only this workspace's legacy manual company proof, without touching native session rows. */
export const revokeManualCompanyProofs = async (
  transaction: Transaction,
  clock: Clock,
  scope: WorkspaceProjectionScope,
  userId: string,
): Promise<readonly string[]> => {
  requireWorkspaceProjectionScope(transaction, scope);
  const revoked = await transaction
    .updateTable('workspace_identity_sessions')
    .set({ revoked_at: clock.now() })
    .where('workspace_id', '=', scope.workspaceId)
    .where('directory_id', 'is', null)
    .where('revoked_at', 'is', null)
    .where(
      'session_id',
      'in',
      transaction
        .selectFrom('sessions')
        .select('id')
        .where('user_id', '=', userId)
        .where('company_workspace_id', '=', scope.workspaceId),
    )
    .returning('session_id')
    .execute();
  const ids = revoked.map((row) => row.session_id);
  if (ids.length > 0) noteCompanySessionsEnded(transaction, scope, ids);
  return ids;
};

/** Shared with native removal/leave: configured sources survive, while every retained proof becomes stale. */
export const blockWorkspaceAdmission = async (
  transaction: Transaction,
  clock: Clock,
  scope: WorkspaceProjectionScope,
  userId: string,
): Promise<void> => {
  requireWorkspaceProjectionScope(transaction, scope);
  await requireRelatedWorkspacePerson(transaction, scope, userId);
  const control = await initializeWorkspaceAdmission(transaction, clock, scope, userId);
  if (control.blocked_at !== null) return;
  const now = clock.now();
  await transaction
    .updateTable('workspace_admission_controls')
    .set({ blocked_at: now, revision: crypto.randomUUID(), updated_at: now })
    .where('workspace_id', '=', scope.workspaceId)
    .where('user_id', '=', userId)
    .execute();
  await sql`update workspace_access_sources set revision=gen_random_uuid(), authorization_revision=gen_random_uuid(), updated_at=${now} where workspace_id=${scope.workspaceId} and user_id=${userId} and state <> 'retired'`.execute(
    transaction,
  );
  noteWorkspaceAccessChange(transaction, scope, [userId]);
};

export const addManualWorkspaceAccess = async (
  dependencies: WorkspaceProvisioningDependencies,
  actor: WorkspaceProvisioningActor,
  userId: string,
  input: AddManualWorkspaceAccessRequest,
): Promise<WorkspaceMemberAccess> =>
  await administerWorkspaceAccess(
    dependencies,
    actor,
    'grant',
    async (transaction, scope, context) => {
      const control = await controlFor(
        transaction,
        dependencies.clock,
        scope,
        userId,
        input.revision,
      );
      if (control.blocked_at !== null) throw managedMembership();
      const native = await transaction
        .selectFrom('workspace_members')
        .select(['role', 'access_kind'])
        .where('workspace_id', '=', scope.workspaceId)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if ((native?.access_kind ?? control.last_access_kind) === 'guest')
        throw provisioningForbidden();
      const role = native?.role ?? control.last_builtin_role;
      protectTarget(context, role, input.role);
      if (role === 'owner' && input.role !== 'owner')
        await requireAnotherOwner(transaction, scope, userId);
      const source = await transaction
        .selectFrom('workspace_access_sources')
        .selectAll()
        .where('workspace_id', '=', scope.workspaceId)
        .where('user_id', '=', userId)
        .where('kind', '=', 'manual')
        .where('state', '!=', 'retired')
        .executeTakeFirst();
      if (source?.state === 'active' && source.builtin_role === input.role)
        return await accessFor(transaction, dependencies.clock, scope, userId);
      const now = dependencies.clock.now();
      const updated =
        source === undefined
          ? await transaction
              .insertInto('workspace_access_sources')
              .values({
                workspace_id: scope.workspaceId,
                user_id: userId,
                kind: 'manual',
                state: 'active',
                builtin_role: input.role,
                access_kind: 'member',
                admitted_at: now,
                created_at: now,
                updated_at: now,
              })
              .returning('id')
              .executeTakeFirstOrThrow()
          : await transaction
              .updateTable('workspace_access_sources')
              .set({
                state: 'active',
                builtin_role: input.role,
                revision: crypto.randomUUID(),
                authorization_revision: crypto.randomUUID(),
                updated_at: now,
              })
              .where('workspace_id', '=', scope.workspaceId)
              .where('id', '=', source.id)
              .returning('id')
              .executeTakeFirstOrThrow();
      noteWorkspaceAccessChange(transaction, scope, [userId]);
      await projectWorkspaceAccess(
        transaction,
        dependencies.clock,
        scope,
        [userId],
        dependencies.channels,
      );
      await recordAudit(transaction, dependencies.clock, {
        workspaceId: scope.workspaceId,
        actorUserId: context.userId,
        action: 'workspace.access.manual_added',
        targetType: 'user',
        targetId: userId,
        metadata: { sourceId: updated.id },
      });
      return await accessFor(transaction, dependencies.clock, scope, userId);
    },
  );

export const revokeWorkspaceAccessSource = async (
  dependencies: WorkspaceProvisioningDependencies,
  actor: WorkspaceProvisioningActor,
  userId: string,
  sourceId: string,
  input: RevokeWorkspaceAccessSourceRequest,
): Promise<WorkspaceMemberAccess> =>
  await administerWorkspaceAccess(
    dependencies,
    actor,
    'revoke',
    async (transaction, scope, context) => {
      await requireRelatedWorkspacePerson(transaction, scope, userId);
      const source = await transaction
        .selectFrom('workspace_access_sources')
        .selectAll()
        .where('workspace_id', '=', scope.workspaceId)
        .where('user_id', '=', userId)
        .where('id', '=', sourceId)
        .where('state', '!=', 'retired')
        .executeTakeFirst();
      if (source === undefined) throw sourceNotFound();
      if (source.revision !== input.revision) throw provisioningChanged();
      const control = await initializeWorkspaceAdmission(
        transaction,
        dependencies.clock,
        scope,
        userId,
      );
      const role = await targetRole(transaction, scope, userId, control);
      protectTarget(context, role);
      if (source.state !== 'active')
        return await accessFor(transaction, dependencies.clock, scope, userId);
      if (role === 'owner') {
        const ownerSource = await transaction
          .selectFrom('workspace_access_sources')
          .select('id')
          .where('workspace_id', '=', scope.workspaceId)
          .where('user_id', '=', userId)
          .where('id', '!=', source.id)
          .where('state', '=', 'active')
          .where('builtin_role', '=', 'owner')
          .executeTakeFirst();
        if (ownerSource === undefined) await requireAnotherOwner(transaction, scope, userId);
      }
      await transaction
        .updateTable('workspace_access_sources')
        .set({
          state: 'inactive',
          revision: crypto.randomUUID(),
          authorization_revision: crypto.randomUUID(),
          updated_at: dependencies.clock.now(),
        })
        .where('workspace_id', '=', scope.workspaceId)
        .where('id', '=', source.id)
        .execute();
      if (source.kind === 'manual')
        await revokeManualCompanyProofs(transaction, dependencies.clock, scope, userId);
      noteWorkspaceAccessChange(transaction, scope, [userId]);
      await projectWorkspaceAccess(
        transaction,
        dependencies.clock,
        scope,
        [userId],
        dependencies.channels,
      );
      await recordAudit(transaction, dependencies.clock, {
        workspaceId: scope.workspaceId,
        actorUserId: context.userId,
        action: 'workspace.access.source_revoked',
        targetType: 'user',
        targetId: userId,
        metadata: { sourceId: source.id },
      });
      return await accessFor(transaction, dependencies.clock, scope, userId);
    },
  );

export const previewWorkspaceOffboarding = async (
  dependencies: WorkspaceProvisioningDependencies,
  actor: WorkspaceProvisioningActor,
  userId: string,
  input: PreviewWorkspaceOffboardingRequest,
): Promise<WorkspaceOffboardingPreview> =>
  await administerWorkspaceAccess(
    dependencies,
    actor,
    'read',
    async (transaction, scope, context) => {
      const control = await controlFor(
        transaction,
        dependencies.clock,
        scope,
        userId,
        input.revision,
      );
      const role = await targetRole(transaction, scope, userId, control);
      const reason =
        context.role !== 'owner' && role === 'owner'
          ? 'protected_role'
          : role === 'owner' && (await lastOwner(transaction, scope, userId))
            ? 'last_owner'
            : null;
      const sessions = await transaction
        .selectFrom('sessions')
        .innerJoin('workspace_identity_sessions as proof', 'proof.session_id', 'sessions.id')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('sessions.user_id', '=', userId)
        .where('sessions.company_workspace_id', '=', scope.workspaceId)
        .where('proof.workspace_id', '=', scope.workspaceId)
        .where('proof.revoked_at', 'is', null)
        .where('sessions.revoked_at', 'is', null)
        .where('sessions.expires_at', '>', dependencies.clock.now())
        .executeTakeFirstOrThrow();
      const access = await accessFor(transaction, dependencies.clock, scope, userId);
      const affectedChannelCount =
        (await dependencies.channels.access?.countFor(transaction, scope.workspaceId, userId)) ?? 0;
      return {
        access,
        affectedChannelCount,
        sourceSessionCount: Number(sessions.count),
        canOffboard: reason === null,
        reason,
      };
    },
  );

export const offboardWorkspaceMember = async (
  dependencies: WorkspaceProvisioningDependencies,
  actor: WorkspaceProvisioningActor,
  userId: string,
  input: ConfirmWorkspaceOffboardingRequest,
): Promise<WorkspaceMemberAccess> =>
  await administerWorkspaceAccess(
    dependencies,
    actor,
    'revoke',
    async (transaction, scope, context) => {
      const control = await controlFor(
        transaction,
        dependencies.clock,
        scope,
        userId,
        input.revision,
      );
      const role = await targetRole(transaction, scope, userId, control);
      protectTarget(context, role);
      if (control.blocked_at !== null)
        return await accessFor(transaction, dependencies.clock, scope, userId);
      if (role === 'owner') await requireAnotherOwner(transaction, scope, userId);
      await blockWorkspaceAdmission(transaction, dependencies.clock, scope, userId);
      await revokeManualCompanyProofs(transaction, dependencies.clock, scope, userId);
      await projectWorkspaceAccess(
        transaction,
        dependencies.clock,
        scope,
        [userId],
        dependencies.channels,
      );
      await recordAudit(transaction, dependencies.clock, {
        workspaceId: scope.workspaceId,
        actorUserId: context.userId,
        action: 'member.removed',
        targetType: 'user',
        targetId: userId,
        metadata: { role },
      });
      await recordAudit(transaction, dependencies.clock, {
        workspaceId: scope.workspaceId,
        actorUserId: context.userId,
        action: 'workspace.access.member_offboarded',
        targetType: 'user',
        targetId: userId,
      });
      return await accessFor(transaction, dependencies.clock, scope, userId);
    },
  );

export const readmitWorkspaceMember = async (
  dependencies: WorkspaceProvisioningDependencies,
  actor: WorkspaceProvisioningActor,
  userId: string,
  input: ReadmitWorkspaceMemberRequest,
): Promise<WorkspaceMemberAccess> =>
  await administerWorkspaceAccess(
    dependencies,
    actor,
    'grant',
    async (transaction, scope, context) => {
      const control = await controlFor(
        transaction,
        dependencies.clock,
        scope,
        userId,
        input.revision,
      );
      protectTarget(context, control.last_builtin_role);
      if (control.blocked_at === null)
        return await accessFor(transaction, dependencies.clock, scope, userId);
      await transaction
        .updateTable('workspace_admission_controls')
        .set({
          blocked_at: null,
          revision: crypto.randomUUID(),
          updated_at: dependencies.clock.now(),
        })
        .where('workspace_id', '=', scope.workspaceId)
        .where('user_id', '=', userId)
        .execute();
      noteWorkspaceAccessChange(transaction, scope, [userId]);
      if (control.last_access_kind !== 'guest')
        await projectWorkspaceAccess(
          transaction,
          dependencies.clock,
          scope,
          [userId],
          dependencies.channels,
        );
      await recordAudit(transaction, dependencies.clock, {
        workspaceId: scope.workspaceId,
        actorUserId: context.userId,
        action: 'workspace.access.member_readmitted',
        targetType: 'user',
        targetId: userId,
      });
      return await accessFor(transaction, dependencies.clock, scope, userId);
    },
  );
