/** Verified directory integration writes only its exact source in the provided native transaction. */
import { sql, type Transaction } from '@purlay/db';
import { WORKSPACE_ACCESS_SOURCES_MAX } from '@purlay/types/workspace-provisioning';
import { AppError } from '../../../platform/errors';
import { provisioningForbidden, type WorkspaceProvisioningDependencies } from './authority';
import { initializeWorkspaceAdmission } from './native-state';
import { projectWorkspaceAccess } from './projection';
import { requireWorkspaceProjectionScope, type WorkspaceProjectionScope } from './scope';

interface DirectorySourceInput {
  readonly directoryId: string;
  readonly directoryLinkReference: string;
  readonly userId: string;
  readonly active: boolean;
  readonly name: string | null;
}

/** Input IDs come from the verified principal/exact plugin link, never a guessed email or body user ID. */
export const reconcileDirectoryWorkspaceSource = async (
  transaction: Transaction,
  dependencies: Pick<WorkspaceProvisioningDependencies, 'clock' | 'channels'>,
  scope: WorkspaceProjectionScope,
  input: DirectorySourceInput,
): Promise<{
  readonly sourceId: string;
  readonly sourceRevision: string;
  readonly authorizationRevision: string;
  readonly admissionRevision: string;
}> => {
  requireWorkspaceProjectionScope(transaction, scope);
  const control = await initializeWorkspaceAdmission(
    transaction,
    dependencies.clock,
    scope,
    input.userId,
  );
  const native = await transaction
    .selectFrom('workspace_members')
    .select('access_kind')
    .where('workspace_id', '=', scope.workspaceId)
    .where('user_id', '=', input.userId)
    .executeTakeFirst();
  if (
    input.active &&
    (native?.access_kind === 'guest' ||
      (native === undefined && control.last_access_kind === 'guest'))
  )
    throw provisioningForbidden();
  if (
    input.name !== null &&
    (input.name.length === 0 || input.name.length > 128 || input.name !== input.name.trim())
  )
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Invalid directory source label.',
      details: { fields: { name: 'Use a source label of at most 128 characters.' } },
    });
  const retired = await transaction
    .selectFrom('workspace_access_sources')
    .select('id')
    .where('workspace_id', '=', scope.workspaceId)
    .where('user_id', '=', input.userId)
    .where('kind', '=', 'directory')
    .where('directory_id', '=', input.directoryId)
    .where('directory_link_reference', '=', input.directoryLinkReference)
    .where('state', '=', 'retired')
    .executeTakeFirst();
  if (retired !== undefined) throw provisioningForbidden();
  const existing = await transaction
    .selectFrom('workspace_access_sources')
    .selectAll()
    .where('workspace_id', '=', scope.workspaceId)
    .where('user_id', '=', input.userId)
    .where('kind', '=', 'directory')
    .where('directory_id', '=', input.directoryId)
    .where('state', '!=', 'retired')
    .executeTakeFirst();
  if (existing !== undefined && existing.directory_link_reference !== input.directoryLinkReference)
    throw provisioningForbidden();
  const state = input.active ? 'active' : 'inactive';
  const now = dependencies.clock.now();
  let source = existing;
  let changed = false;
  if (existing === undefined) {
    const count = await transaction
      .selectFrom('workspace_access_sources')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('workspace_id', '=', scope.workspaceId)
      .where('user_id', '=', input.userId)
      .where('kind', '=', 'directory')
      .where('state', '!=', 'retired')
      .executeTakeFirstOrThrow();
    if (Number(count.count) >= WORKSPACE_ACCESS_SOURCES_MAX - 1)
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: 'Too many active directory identities.',
        details: {
          fields: {
            sources:
              'A person can have at most sixteen current directory sources in one workspace.',
          },
        },
      });
    source = await transaction
      .insertInto('workspace_access_sources')
      .values({
        workspace_id: scope.workspaceId,
        user_id: input.userId,
        kind: 'directory',
        directory_id: input.directoryId,
        directory_link_reference: input.directoryLinkReference,
        name: input.name,
        state,
        builtin_role: 'member',
        access_kind: 'member',
        admitted_at: now,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    changed = true;
  } else if (existing.state !== state || existing.name !== input.name) {
    source = await transaction
      .updateTable('workspace_access_sources')
      .set({
        state,
        name: input.name,
        revision: crypto.randomUUID(),
        updated_at: now,
        ...(existing.state === state ? {} : { authorization_revision: crypto.randomUUID() }),
      })
      .where('workspace_id', '=', scope.workspaceId)
      .where('id', '=', existing.id)
      .where('revision', '=', existing.revision)
      .returningAll()
      .executeTakeFirstOrThrow();
    changed = true;
  }
  if (source === undefined) throw new Error('A reconciled directory source disappeared.');
  if (changed)
    await projectWorkspaceAccess(
      transaction,
      dependencies.clock,
      scope,
      [input.userId],
      dependencies.channels,
    );
  const current = await transaction
    .selectFrom('workspace_admission_controls')
    .select('revision')
    .where('workspace_id', '=', scope.workspaceId)
    .where('user_id', '=', input.userId)
    .executeTakeFirstOrThrow();
  return {
    sourceId: source.id,
    sourceRevision: source.revision,
    authorizationRevision: source.authorization_revision,
    admissionRevision: current.revision,
  };
};

/** DELETE retires the exact old resource; a delayed old delete cannot revoke its replacement. */
export const retireDirectoryWorkspaceSource = async (
  transaction: Transaction,
  dependencies: Pick<WorkspaceProvisioningDependencies, 'clock' | 'channels'>,
  scope: WorkspaceProjectionScope,
  input: {
    readonly directoryId: string;
    readonly directoryLinkReference: string;
    readonly userId: string;
  },
): Promise<void> => {
  requireWorkspaceProjectionScope(transaction, scope);
  const source = await transaction
    .selectFrom('workspace_access_sources')
    .selectAll()
    .where('workspace_id', '=', scope.workspaceId)
    .where('user_id', '=', input.userId)
    .where('kind', '=', 'directory')
    .where('directory_id', '=', input.directoryId)
    .where('directory_link_reference', '=', input.directoryLinkReference)
    .where('state', '!=', 'retired')
    .executeTakeFirst();
  if (source === undefined) return;
  const now = dependencies.clock.now();
  await transaction
    .updateTable('workspace_access_sources')
    .set({
      state: 'retired',
      retired_at: now,
      revision: crypto.randomUUID(),
      authorization_revision: crypto.randomUUID(),
      updated_at: now,
    })
    .where('workspace_id', '=', scope.workspaceId)
    .where('id', '=', source.id)
    .execute();
  await transaction
    .deleteFrom('workspace_access_role_grants')
    .where('workspace_id', '=', scope.workspaceId)
    .where('source_id', '=', source.id)
    .execute();
  await transaction
    .deleteFrom('workspace_access_group_members')
    .where('workspace_id', '=', scope.workspaceId)
    .where('source_id', '=', source.id)
    .execute();
  await projectWorkspaceAccess(
    transaction,
    dependencies.clock,
    scope,
    [input.userId],
    dependencies.channels,
  );
};

/** Directory decommission is set-wise and never locks or deletes the target's native sessions. */
export const deactivateDirectorySources = async (
  transaction: Transaction,
  dependencies: Pick<WorkspaceProvisioningDependencies, 'clock' | 'channels'>,
  scope: WorkspaceProjectionScope,
  directoryId: string,
): Promise<readonly string[]> => {
  requireWorkspaceProjectionScope(transaction, scope);
  const changed = await sql<{ readonly user_id: string }>`
    update workspace_access_sources
    set state = 'inactive', revision = gen_random_uuid(), authorization_revision = gen_random_uuid(),
      updated_at = ${dependencies.clock.now()}
    where workspace_id = ${scope.workspaceId} and directory_id = ${directoryId}
      and kind = 'directory' and state = 'active'
    returning user_id
  `.execute(transaction);
  const userIds = [...new Set(changed.rows.map((row) => row.user_id))].sort();
  await projectWorkspaceAccess(
    transaction,
    dependencies.clock,
    scope,
    userIds,
    dependencies.channels,
  );
  return userIds;
};
