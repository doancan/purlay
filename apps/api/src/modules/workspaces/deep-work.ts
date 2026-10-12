/**
 * Deep Work (D-15, D-108): a member's own, per workspace, stored on the server so it holds on every
 * device and the server itself stops delivering.
 *
 * **It ends by itself.** Started until an instant no further than `DEEP_WORK_MAX_HOURS` ahead, and
 * over when the clock passes it: every reader compares with the clock (`inDeepWork`, the membership),
 * so no job has to run to end it and no node can miss the moment.
 *
 * **Nothing is lost.** While it lasts a notification is still written and still counted; it is
 * written `suppressed_by_deep_work`, which is what a delivery that interrupts — a push, a sound — will
 * honour, and what a digest can be built from later.
 */
import type { Executor } from '@purlay/db';
import { DEEP_WORK_MAX_HOURS, type DeepWorkResponse, type SetDeepWorkRequest } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import type { WorkspaceContext } from '../../platform/tenancy';

const HOUR_MS = 3_600_000;

export const setDeepWork = async (
  executor: Executor,
  clock: Clock,
  context: WorkspaceContext,
  input: SetDeepWorkRequest,
): Promise<DeepWorkResponse> => {
  let until: Date | null = null;
  if (input.active) {
    until = new Date(input.until);
    const now = clock.now().getTime();
    if (until.getTime() <= now || until.getTime() > now + DEEP_WORK_MAX_HOURS * HOUR_MS) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: `Deep Work ends in the future, at most ${String(DEEP_WORK_MAX_HOURS)} hours from now.`,
        details: { fields: { until: `ahead, and at most ${String(DEEP_WORK_MAX_HOURS)} hours` } },
      });
    }
  }
  await executor
    .updateTable('workspace_members')
    .set({ is_deep_work_active: input.active, deep_work_until: until })
    .where('workspace_id', '=', context.workspaceId)
    .where('user_id', '=', context.userId)
    .execute();
  return { until: until === null ? null : until.toISOString() };
};

/** Which of these people are in Deep Work in this workspace at `now`. */
export const inDeepWork = async (
  executor: Executor,
  workspaceId: string,
  userIds: readonly string[],
  now: Date,
): Promise<ReadonlySet<string>> => {
  if (userIds.length === 0) return new Set();
  const rows = await executor
    .selectFrom('workspace_members')
    .select('user_id')
    .where('workspace_id', '=', workspaceId)
    .where('user_id', 'in', userIds)
    .where('is_deep_work_active', '=', true)
    .where('deep_work_until', '>', now)
    .execute();
  return new Set(rows.map((row) => row.user_id));
};
