/**
 * Deleting a workspace (D-242): asked for by an owner, taken back by any owner within the grace period,
 * erased after it by `purge:workspaces` (`deletion-purge.ts`).
 *
 * - **Asked for by an owner, typing its name**: the one act here that ends in an erasure. An admin or a
 *   member is refused for what they are (`403`), after their membership has made the workspace exist for
 *   them; a stranger is the stranger's `404`.
 * - **Gone at once, for everybody**: `deleted_at` is set, and the tenancy guard has always refused a
 *   workspace with it — every route, every socket's next subscription, every invitation link. Its owners
 *   alone still see it, as a deletion they can take back (`scheduledDeletionsOf`, read with `GET /api/me`).
 * - **Taken back by any owner**, not only the one who asked: until the job claims it, under the row's lock,
 *   which taking it back waits on too — so a cancellation and the erasure cannot both win.
 * - **Asked twice is asked once** (D-33): the second answers the first's schedule and records nothing; taken
 *   back twice, the same.
 * - **On the workspace's trail**, both, with when its content goes — not the name, which the row keeps.
 */
import type { Executor, Transaction } from '@purlay/db';
import {
  WORKSPACE_DELETION_GRACE_DAYS,
  type Workspace,
  type WorkspaceDeletion,
} from '@purlay/types';
import { DAY_MS, type Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { workspaceNotFound, type DeletionContext } from '../../platform/tenancy';
import { recordAudit } from '../audit/audit';

const ownersOnly = (): AppError =>
  new AppError({ code: 'FORBIDDEN', message: 'Only an owner deletes the workspace.' });

const started = (): AppError =>
  new AppError({
    code: 'WORKSPACE_DELETION_STARTED',
    message: 'The workspace is already being erased; its deletion can no longer be taken back.',
  });

/** When a workspace whose deletion was asked for at this instant loses its content. */
const purgeAtFor = (deletedAt: Date): string =>
  new Date(deletedAt.getTime() + WORKSPACE_DELETION_GRACE_DAYS * DAY_MS).toISOString();

/** The row under its lock, which the job's claim and every other deletion request wait on. */
const lockedRow = async (
  executor: Transaction,
  context: DeletionContext,
): Promise<{
  readonly workspace: Workspace;
  readonly deletedAt: Date | null;
}> => {
  const row = await executor
    .selectFrom('workspaces')
    .select(['id', 'name', 'slug', 'avatar_url', 'deleted_at', 'purge_started_at'])
    .where('id', '=', context.workspaceId)
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) throw workspaceNotFound();
  // The role as it is now, under the lock a role change takes too: an owner demoted after the request
  // began is not one here (#527), whatever the guard read before. The only check of it: a member is
  // refused for what they are before anything else is said.
  const member = await executor
    .selectFrom('workspace_members')
    .select('role')
    .where('workspace_id', '=', context.workspaceId)
    .where('user_id', '=', context.userId)
    .executeTakeFirst();
  if (member === undefined) throw workspaceNotFound();
  if (member.role !== 'owner') throw ownersOnly();
  if (row.purge_started_at !== null) throw started();
  return {
    workspace: { id: row.id, name: row.name, slug: row.slug, avatarUrl: row.avatar_url },
    deletedAt: row.deleted_at === null ? null : new Date(row.deleted_at),
  };
};

/** Everyone in it and every channel of it: who is told it went, or came back, after the commit. */
const audience = async (
  executor: Executor,
  workspaceId: string,
): Promise<{ readonly memberIds: readonly string[]; readonly channelIds: readonly string[] }> => {
  const members = await executor
    .selectFrom('workspace_members')
    .select('user_id')
    .where('workspace_id', '=', workspaceId)
    .execute();
  const channels = await executor
    .selectFrom('channels')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .execute();
  return {
    memberIds: members.map((member) => member.user_id),
    channelIds: channels.map((channel) => channel.id),
  };
};

/** What asking did: the schedule, and — when it was not asked already — who and what to tell. */
export interface Asked {
  readonly deletion: WorkspaceDeletion;
  /** Empty when it was asked already: nothing changed, and nobody is told again. */
  readonly memberIds: readonly string[];
  readonly channelIds: readonly string[];
}

/**
 * An owner asks for the workspace to be deleted, inside the caller's transaction. The typed name is
 * compared as the workspace's is stored, both in one Unicode form: a name typed on a keyboard that
 * composes `ğ` differently is the same name.
 */
export const askToDelete = async (
  executor: Transaction,
  clock: Clock,
  context: DeletionContext,
  confirm: string,
): Promise<Asked> => {
  const { workspace, deletedAt } = await lockedRow(executor, context);
  if (confirm.normalize('NFC') !== workspace.name.normalize('NFC')) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'The request did not match the contract.',
      details: { fields: { confirm: 'is not the workspace’s name' } },
    });
  }
  if (deletedAt !== null) {
    return {
      deletion: { workspace, purgeAt: purgeAtFor(deletedAt) },
      memberIds: [],
      channelIds: [],
    };
  }
  const now = clock.now();
  await executor
    .updateTable('workspaces')
    .set({ deleted_at: now, updated_at: now })
    .where('id', '=', context.workspaceId)
    .execute();
  const purgeAt = purgeAtFor(now);
  await recordAudit(executor, clock, {
    workspaceId: context.workspaceId,
    actorUserId: context.userId,
    action: 'workspace.deletion_requested',
    targetType: 'workspace',
    targetId: context.workspaceId,
    metadata: { purgeAt },
  });
  return { deletion: { workspace, purgeAt }, ...(await audience(executor, context.workspaceId)) };
};

/**
 * Any owner takes the deletion back, inside the caller's transaction: the workspace is as it was, for
 * everybody. Answers who to tell; nobody when there was nothing to take back.
 */
export const takeBackDeletion = async (
  executor: Transaction,
  clock: Clock,
  context: DeletionContext,
): Promise<{ readonly memberIds: readonly string[] }> => {
  const { deletedAt } = await lockedRow(executor, context);
  if (deletedAt === null) return { memberIds: [] };
  await executor
    .updateTable('workspaces')
    .set({ deleted_at: null, updated_at: clock.now() })
    .where('id', '=', context.workspaceId)
    .execute();
  await recordAudit(executor, clock, {
    workspaceId: context.workspaceId,
    actorUserId: context.userId,
    action: 'workspace.deletion_cancelled',
    targetType: 'workspace',
    targetId: context.workspaceId,
  });
  const { memberIds } = await audience(executor, context.workspaceId);
  return { memberIds };
};

/**
 * The deletions this person can still take back: workspaces they own, asked for and not yet claimed by
 * the job. Not scoped by a context, as `membershipsOf` is not: the filter is the person, an owner's row.
 */
export const scheduledDeletionsOf = async (
  executor: Executor,
  userId: string,
): Promise<readonly WorkspaceDeletion[]> => {
  const rows = await executor
    .selectFrom('workspace_members')
    .innerJoin('workspaces', 'workspaces.id', 'workspace_members.workspace_id')
    .select([
      'workspaces.id',
      'workspaces.name',
      'workspaces.slug',
      'workspaces.avatar_url',
      'workspaces.deleted_at',
    ])
    .where('workspace_members.user_id', '=', userId)
    .where('workspace_members.role', '=', 'owner')
    .where('workspaces.deleted_at', 'is not', null)
    .where('workspaces.purge_started_at', 'is', null)
    .orderBy('workspaces.deleted_at', 'asc')
    .execute();
  return rows.flatMap((row) =>
    row.deleted_at === null
      ? []
      : [
          {
            workspace: {
              id: row.id,
              name: row.name,
              slug: row.slug,
              avatarUrl: row.avatar_url,
            },
            purgeAt: purgeAtFor(new Date(row.deleted_at)),
          },
        ],
  );
};
