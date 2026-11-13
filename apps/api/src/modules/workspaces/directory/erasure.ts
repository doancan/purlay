/** Native SCIM resource erasure follows exact directory ownership; shared subjects survive workspace purge. */
import { sql, type Transaction } from '@purlay/db';

/** Only the canonical global account-erasure path may remove this person's shared native subject. */
export const eraseDirectoryUser = async (
  transaction: Transaction,
  userId: string,
): Promise<void> => {
  await transaction
    .deleteFrom('workspace_directory_scim_grants')
    .where('user_id', '=', userId)
    .execute();
  await transaction
    .deleteFrom('workspace_directory_scim_users')
    .where('user_id', '=', userId)
    .execute();
  await transaction
    .deleteFrom('workspace_directory_scim_tombstones')
    .where('user_id', '=', userId)
    .execute();
  await transaction
    .deleteFrom('workspace_directory_scim_subjects')
    .where('user_id', '=', userId)
    .execute();
};
/** The caller retains directory rows until this bounded native cleanup has completed. */
export const purgeWorkspaceDirectoryState = async (
  transaction: Transaction,
  workspaceId: string,
  limit: number,
): Promise<number> => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new Error('Directory purge requires a bounded batch.');
  let remaining = limit;
  let changed = 0;
  for (const table of [
    'workspace_directory_scim_grants',
    'workspace_directory_scim_group_members',
    'workspace_directory_scim_users',
    'workspace_directory_scim_tombstones',
    'workspace_directory_scim_groups',
    'workspace_directory_scim_bindings',
  ] as const) {
    if (remaining === 0) break;
    const result = await sql<{
      readonly id: string;
    }>`delete from ${sql.table(table)} as resource where resource.id in (
    select owned.id from ${sql.table(table)} as owned
    join workspace_directories as directory on directory.id::text=owned.connection_id
    where directory.workspace_id=${workspaceId}
    ${table === 'workspace_directory_scim_group_members' ? sql`` : sql`and owned.provisioning_domain_id=${workspaceId}`}
    order by owned.id limit ${remaining}
  ) returning resource.id`.execute(transaction);
    remaining -= result.rows.length;
    changed += result.rows.length;
  }
  return changed;
};
