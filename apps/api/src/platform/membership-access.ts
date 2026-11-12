/** Live guest authority is checked by the database, independently of delayed expiry cleanup. */
import { sql, type RawBuilder } from '@purlay/db';
import { currentRequest } from './logging';
import { liveCompanySessionProof } from './company-session';

/** The canonical guards join this table without an alias; a normal membership keeps its old behavior. */
export const activeWorkspaceMembership = (): RawBuilder<boolean> => {
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
  return sql<boolean>`${source} and (
  workspace_members.access_kind = 'member'
  or (
    workspace_members.access_kind = 'guest'
    and workspace_members.guest_since <= statement_timestamp()
    and (workspace_members.guest_expires_at is null
      or workspace_members.guest_expires_at > statement_timestamp())
  )
)`;
};
