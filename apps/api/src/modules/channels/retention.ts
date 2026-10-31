/**
 * How long a channel keeps its history, when that is longer than its workspace does (D-225): forever,
 * or at least so many whole days. **Only ever longer**, so no setting here deletes more than the
 * workspace's own window already would: a floor shorter than the workspace keeps now is refused, and a
 * workspace window lengthened past it later simply wins. What is kept is the longer of the two, which
 * the purge computes for itself on every batch (`modules/retention/purge.ts`); `effectiveDays` here is
 * that same rule, said to the owner.
 *
 * An owner's, to read and to set, as the workspace's window is (D-139 §4): keeping a team's history
 * longer than the workspace's policy is the policy's owner's call. Every change is on the trail with what
 * it was and what it became; the same setting again writes nothing. A direct message has none: it is the
 * stranger's `404`, as every channel setting answers one (D-123).
 */
import type { Transaction, Executor } from '@purlay/db';
import type { ChannelRetention, ChannelRetentionFloor } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { channelNotFound, type ChannelContext } from '../../platform/channels';
import { AppError } from '../../platform/errors';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { recordAudit } from '../audit/audit';

const ownersOnly = (): AppError =>
  new AppError({
    code: 'FORBIDDEN',
    message: 'Only an owner decides how long a channel keeps its history.',
  });

/** What the purge keeps: the longer of the two windows, `null` — everything — the longest of all. */
const effectiveDays = (
  workspaceDays: number | null,
  keepsAtLeast: ChannelRetentionFloor,
): number | null => {
  if (workspaceDays === null || keepsAtLeast === 'forever') return null;
  return keepsAtLeast === null ? workspaceDays : Math.max(workspaceDays, keepsAtLeast);
};

const floorOf = (row: {
  readonly min_retention_days: number | null;
  readonly retain_forever: boolean;
}): ChannelRetentionFloor => (row.retain_forever ? 'forever' : row.min_retention_days);

/** How a floor is said on the trail: `workspace`, `forever`, or its days. */
const said = (floor: ChannelRetentionFloor): string =>
  floor === null ? 'workspace' : String(floor);

const requireOwner = async (executor: Executor, context: ChannelContext): Promise<void> => {
  const { role } = await requireWorkspaceMembership(executor, context.userId, context.workspaceId);
  if (role !== 'owner') throw ownersOnly();
};

const workspaceDaysOf = async (
  executor: Executor,
  context: ChannelContext,
  lock: boolean,
): Promise<number | null> => {
  const query = executor
    .selectFrom('workspaces')
    .select('retention_days')
    .where('id', '=', context.workspaceId);
  // KEY SHARE: the workspace's own window waits for this to commit (its change takes the row FOR
  // UPDATE), and nothing else on the row — an upload counting its bytes — is held up by it.
  const row = await (lock ? query.forKeyShare() : query).executeTakeFirstOrThrow();
  return row.retention_days;
};

export const readChannelRetention = async (
  executor: Executor,
  context: ChannelContext,
): Promise<ChannelRetention> => {
  if (context.channelType === 'direct_message') throw channelNotFound();
  await requireOwner(executor, context);
  const workspaceDays = await workspaceDaysOf(executor, context, false);
  const row = await executor
    .selectFrom('channels')
    .select(['min_retention_days', 'retain_forever'])
    .where('id', '=', context.channelId)
    .executeTakeFirstOrThrow();
  const keepsAtLeast = floorOf(row);
  return { keepsAtLeast, workspaceDays, effectiveDays: effectiveDays(workspaceDays, keepsAtLeast) };
};

/**
 * Sets the channel's floor. The locks are the order every writer here takes them: the workspace row
 * (so its window cannot change between the check and the commit), then the channel row (so two owners
 * at once each record what the other left); the role is read again under them, as a rename does (#527).
 */
export const setChannelRetention = async (
  executor: Transaction,
  clock: Clock,
  context: ChannelContext,
  keepsAtLeast: ChannelRetentionFloor,
): Promise<ChannelRetention> => {
  if (context.channelType === 'direct_message') throw channelNotFound();
  const workspaceDays = await workspaceDaysOf(executor, context, true);
  const before = await executor
    .selectFrom('channels')
    .select(['min_retention_days', 'retain_forever'])
    .where('id', '=', context.channelId)
    .where('deleted_at', 'is', null)
    .forNoKeyUpdate()
    .executeTakeFirst();
  // Archived between the guard's read and this lock: gone, as the guard would now say.
  if (before === undefined) throw channelNotFound();
  await requireOwner(executor, context);
  const answer = {
    keepsAtLeast,
    workspaceDays,
    effectiveDays: effectiveDays(workspaceDays, keepsAtLeast),
  };
  const was = floorOf(before);
  // The same setting again is what is already there, refused or not by today's window: a retry of a
  // change that succeeded succeeds (D-33), and the purge takes the longer window whatever is stored.
  if (was === keepsAtLeast) return answer;
  if (
    typeof keepsAtLeast === 'number' &&
    (workspaceDays === null || keepsAtLeast < workspaceDays)
  ) {
    throw new AppError({
      code: 'RETENTION_TOO_SHORT',
      message:
        workspaceDays === null
          ? 'The workspace keeps everything; a channel can only keep longer, and nothing is longer.'
          : `The workspace keeps ${String(workspaceDays)} days; a channel can only keep longer.`,
    });
  }
  await executor
    .updateTable('channels')
    .set({
      retain_forever: keepsAtLeast === 'forever',
      min_retention_days: typeof keepsAtLeast === 'number' ? keepsAtLeast : null,
      updated_at: clock.now(),
    })
    .where('id', '=', context.channelId)
    .execute();
  await recordAudit(executor, clock, {
    workspaceId: context.workspaceId,
    actorUserId: context.userId,
    action: 'channel.retention_changed',
    targetType: 'channel',
    targetId: context.channelId,
    metadata: { from: said(was), to: said(keepsAtLeast) },
  });
  return answer;
};
