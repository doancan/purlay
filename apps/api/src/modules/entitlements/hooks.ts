/**
 * The hooks of a module that act without a request of the module (D-289 §9): a reader of files, the start of a new workspace and
 * the pushes of what a write told. A route is guarded by the workspace's grant where the membership is read; these never pass
 * a route of the module, so the composition wraps each in the same question, answered by the same function of the grants.
 * What they ask is "may this workspace use the module": the answer to a no is the one the module not being run gives.
 *
 * What is not wrapped is the data's lifecycle: retention, erasure, purge and both exports cover a module's rows whoever is
 * granted it (D-289 §6), and a sweep that stopped for a workspace that lost a module would keep its rows for ever.
 */
import type { Executor } from '@purlay/db';
import { attachmentNotFound } from '../../platform/errors';
import { asGrants, grantColumns } from '../../platform/grants';
import type { EntitlementPolicy } from '../../platform/module-kit/entitlement';
import { entitledTo } from '../../platform/tenancy';
import type { AttachmentReader } from '../attachments/readable';
import type { PushNotices } from '../push/notices';
import type { WorkspaceCreated } from '../workspaces/workspaces';

type Effective = EntitlementPolicy['effective'];

/** The modules a workspace may use now, judged by the database's clock as the guard's read is; none for a workspace that is not there. */
const modulesOf = async (
  executor: Executor,
  workspaceId: string,
  effective: Effective,
): Promise<ReadonlySet<string>> => {
  const row = await executor
    .selectFrom('workspaces')
    .select(grantColumns)
    .where('workspaces.id', '=', workspaceId)
    .executeTakeFirst();
  return row === undefined ? new Set() : effective(asGrants(row.grants), row.read_at);
};

/**
 * A module's reader of files, which says no (as `attachmentNotFound`, like any reader) for a file of a workspace not granted the
 * module. Asked after the module's own reader, so a file nobody may read costs what it did and an unknown id is not told apart.
 */
export const entitledReader =
  (module: string, read: AttachmentReader, effective: Effective): AttachmentReader =>
  async (executor, userId, attachmentId) => {
    const file = await read(executor, userId, attachmentId);
    const stored = await executor
      .selectFrom('attachments')
      .select('workspace_id')
      .where('id', '=', file.id)
      .executeTakeFirst();
    if (
      stored === undefined ||
      !(await modulesOf(executor, stored.workspace_id, effective)).has(module)
    ) {
      throw attachmentNotFound();
    }
    return file;
  };

/** A module's start for a new workspace, run only if the workspace's grants (as the guard minted them) include the module. */
export const entitledStart =
  (module: string, start: (...args: Parameters<WorkspaceCreated['run']>) => Promise<void>) =>
  async (...args: Parameters<WorkspaceCreated['run']>): Promise<void> => {
    const [, , context] = args;
    if (entitledTo(context, module)) await start(...args);
  };

/** A module's push notices, less those of workspaces not granted the module. */
export const entitledNotices = (
  module: string,
  notices: PushNotices,
  effective: Effective,
): PushNotices => ({
  canDeliver: async (executor, messageId, userId): Promise<boolean> => {
    if (!(await notices.canDeliver(executor, messageId, userId))) return false;
    const told = await notices.of(executor, messageId, [userId]);
    for (const notice of told) {
      if ((await modulesOf(executor, notice.workspaceId, effective)).has(module)) return true;
    }
    return false;
  },
  of: async (executor, messageId, userIds): ReturnType<PushNotices['of']> => {
    const told = await notices.of(executor, messageId, userIds);
    const granted = new Map<string, boolean>();
    for (const workspaceId of new Set(told.map((notice) => notice.workspaceId))) {
      granted.set(workspaceId, (await modulesOf(executor, workspaceId, effective)).has(module));
    }
    return told.filter((notice) => granted.get(notice.workspaceId) === true);
  },
});
