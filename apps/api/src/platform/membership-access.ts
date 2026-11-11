/** Live guest authority is checked by the database, independently of delayed expiry cleanup. */
import { sql } from '@purlay/db';

/** The canonical guards join this table without an alias; a normal membership keeps its old behavior. */
export const activeWorkspaceMembership = sql<boolean>`(
  workspace_members.access_kind = 'member'
  or (
    workspace_members.access_kind = 'guest'
    and workspace_members.guest_since <= statement_timestamp()
    and (workspace_members.guest_expires_at is null
      or workspace_members.guest_expires_at > statement_timestamp())
  )
)`;
