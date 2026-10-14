/**
 * How long a workspace keeps its history (D-27 §1, D-139 §4): an owner's to read and to set, whole days
 * from 30, or forever. Forever is the default and the tenet (D-2); shortening it is what this product
 * exists to prevent happening silently, so every change is on the trail with what it was and what it
 * became. The nightly purge (`modules/retention/purge.ts`) does the rest.
 */
import type { Executor, Transaction } from '@purlay/db';
import type { RetentionSetting } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import type { WorkspaceContext } from '../../platform/tenancy';
import { recordAudit } from '../audit/audit';
import { requireWorkspaceMembership } from '../../platform/tenancy';

const ownersOnly = (): AppError =>
  new AppError({
    code: 'FORBIDDEN',
    message: 'Only an owner decides how long the workspace keeps its history.',
  });

/** How a window is said on the trail: its days, or `forever`. */
const said = (days: number | null): string => (days === null ? 'forever' : String(days));

export const readRetention = async (
  executor: Executor,
  context: WorkspaceContext,
): Promise<RetentionSetting> => {
  if (context.role !== 'owner') throw ownersOnly();
  const row = await executor
    .selectFrom('workspaces')
    .select('retention_days')
    .where('id', '=', context.workspaceId)
    .where('deleted_at', 'is', null)
    .executeTakeFirstOrThrow();
  return { retentionDays: row.retention_days };
};

/**
 * Sets the window. The row is locked, so two owners at once each record the window the other left;
 * the role is read again under it, as a rename does (#527). The same window again writes nothing.
 */
export const setRetention = async (
  executor: Transaction,
  clock: Clock,
  context: WorkspaceContext,
  retentionDays: number | null,
): Promise<RetentionSetting> => {
  if (context.role !== 'owner') throw ownersOnly();
  const before = await executor
    .selectFrom('workspaces')
    .select('retention_days')
    .where('id', '=', context.workspaceId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const now = await requireWorkspaceMembership(executor, context.userId, context.workspaceId);
  if (now.role !== 'owner') throw ownersOnly();
  if (before.retention_days === retentionDays) return { retentionDays };
  await executor
    .updateTable('workspaces')
    .set({ retention_days: retentionDays, updated_at: clock.now() })
    .where('id', '=', context.workspaceId)
    .execute();
  await recordAudit(executor, clock, {
    workspaceId: context.workspaceId,
    actorUserId: context.userId,
    action: 'retention.changed',
    targetType: 'workspace',
    targetId: context.workspaceId,
    metadata: { from: said(before.retention_days), to: said(retentionDays) },
  });
  return { retentionDays };
};
