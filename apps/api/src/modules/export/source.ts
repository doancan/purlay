/** Prepared archive authority follows its retained native source and exact included workspace set. */
import { sql, type Executor, type RawBuilder } from '@purlay/db';
import type { WorkspaceAccessLifetime } from '../../platform/workspace-access-facts';
import { currentRequest } from '../../platform/logging';
import { workspaceAccessRequired } from '../../platform/workspace-content-access';
import { AppError } from '../../platform/errors';
import { currentWorkspaceContentFence } from '../../platform/workspace-content-fence';
import type { PersonalCatalogue } from './personal-catalogue';

export interface ExportSourceOptions {
  readonly sessionLifetime?: () => WorkspaceAccessLifetime;
  readonly personalCatalogue?: PersonalCatalogue;
}
/** Unknown archive scope cannot be reconstructed from current rows after retention or departure. */
export const requireLegacyPersonalArchive = async (database: Executor): Promise<void> => {
  const governed = await database
    .selectFrom('workspaces')
    .select('id')
    .where('access_policy_epoch', '>', '0')
    .limit(1)
    .executeTakeFirst();
  if (governed !== undefined)
    throw new AppError({ code: 'EXPORT_NOT_FOUND', message: 'Export not found.' });
};

export const legacyPersonalWorkspaces = async (database: Executor): Promise<readonly string[]> => {
  await requireLegacyPersonalArchive(database);
  // This is still unknown scope, never a proven account-only prepared set; the handoff retains its NULL marker.
  return [];
};

/** Call withinDeferredSource first; the returned exact fence belongs only to that scope/statement. */
export const requirePreparedWorkspaceSet = async (
  database: Executor,
  userId: string,
  workspaceIds: readonly string[],
): Promise<RawBuilder<boolean>> => {
  const ids = [...new Set(workspaceIds)];
  if (ids.length === 0) return sql<boolean>`true`;
  const rows = await database
    .selectFrom('workspaces')
    .select(['id', 'access_policy_epoch'])
    .where('id', 'in', ids)
    .execute();
  for (const id of ids) if (!rows.some((row) => row.id === id)) throw workspaceAccessRequired(id);
  const scope = currentRequest();
  for (const workspace of rows) {
    if (scope?.companySession !== undefined && scope.companySession.workspaceId !== workspace.id)
      throw workspaceAccessRequired(workspace.id);
    if (workspace.access_policy_epoch === '0') continue;
    if (scope?.workspaceAccess === undefined) throw workspaceAccessRequired(workspace.id);
    await scope.workspaceAccess(database, userId, workspace.id);
  }
  return sql<boolean>`not exists (
    select 1 from workspaces left join workspace_members
      on workspace_members.workspace_id=workspaces.id and workspace_members.user_id=${userId}
    where workspaces.id in (${sql.join(ids)}) and not coalesce(${currentWorkspaceContentFence()},false)
  )`;
};
