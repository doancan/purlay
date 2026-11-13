/** Live guest authority is checked by the database, independently of delayed expiry cleanup. */
import { sql, type Executor, type RawBuilder } from '@purlay/db';
import { currentRequest } from './logging';
import { liveCompanySessionProof } from './company-session';
import { currentWorkspaceContentFence } from './workspace-content-fence';
import { workspaceAccessRequired } from './workspace-content-access';

/** The canonical guards join this table without an alias; a normal membership keeps its old behavior. */
export const activeWorkspaceMembership = (
  options: { readonly visibilityOnly?: boolean } = {},
): RawBuilder<boolean> => {
  const request = currentRequest();
  const sessionId = request?.companySession === undefined ? undefined : request.sessionId;
  const source =
    request?.companySession === undefined
      ? sql<boolean>`true`
      : sessionId === undefined
        ? sql<boolean>`false`
        : sql<boolean>`(
    workspace_members.user_id <> ${request.companySession.userId} or exists (
      select 1 from sessions as company_source
      where company_source.id = ${sessionId}
        and company_source.user_id = workspace_members.user_id
        and company_source.company_workspace_id = workspace_members.workspace_id
        and company_source.expires_at > statement_timestamp()
        and ${liveCompanySessionProof(sessionId, sql<string>`workspace_members.workspace_id`, sql<string>`workspace_members.user_id`)}
    )
  )`;
  const content =
    options.visibilityOnly === true ? sql<boolean>`true` : currentWorkspaceContentFence();
  return sql<boolean>`${source} and ${content} and (
  workspace_members.access_kind = 'member'
  or (
    workspace_members.access_kind = 'guest'
    and workspace_members.guest_since <= statement_timestamp()
    and (workspace_members.guest_expires_at is null
      or workspace_members.guest_expires_at > statement_timestamp())
  )
)`;
};

/** A streaming handoff rechecks its previously captured authority; it cannot adopt a new proof. */
export const requireCapturedWorkspaceAccess = async (
  executor: Executor,
  userId: string,
  workspaceId: string,
): Promise<void> => {
  const fence = currentRequest()?.workspaceFences?.get(workspaceId);
  if (fence?.userId !== userId) throw workspaceAccessRequired(workspaceId);
  const live = await executor
    .selectFrom('workspace_members')
    .innerJoin('workspaces', 'workspaces.id', 'workspace_members.workspace_id')
    .select('workspace_members.workspace_id')
    .where('workspace_members.user_id', '=', userId)
    .where('workspace_members.workspace_id', '=', workspaceId)
    .where('workspaces.deleted_at', 'is', null)
    .where(activeWorkspaceMembership())
    .executeTakeFirst();
  if (live === undefined) throw workspaceAccessRequired(workspaceId);
};
