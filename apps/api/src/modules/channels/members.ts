/**
 * Who is in a channel (D-104): a member brings in somebody from the workspace. A private channel
 * is reached no other way; a public one can also be joined by the person themselves
 * (`joinChannel`). A direct message is between the two people it was opened for.
 */
import type { Executor } from '@purlay/db';
import type { Channel } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import type { ChannelContext } from '../../platform/channels';
import type { WorkspaceContext } from '../../platform/tenancy';
import { AppError } from '../../platform/errors';
import { channelFor } from './channels';

/**
 * Refuses unless `userId` is a person in the workspace whose account has not been deleted.
 * Another workspace's member, a stranger and an erased account are the same answer.
 */
export const requireWorkspacePerson = async (
  executor: Executor,
  context: Pick<WorkspaceContext, 'workspaceId'>,
  userId: string,
): Promise<void> => {
  const person = await executor
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .select('users.id')
    .where('workspace_members.workspace_id', '=', context.workspaceId)
    .where('workspace_members.user_id', '=', userId)
    .where('users.deleted_at', 'is', null)
    .executeTakeFirst();
  if (person === undefined) {
    throw new AppError({ code: 'USER_NOT_FOUND', message: 'No such person in this workspace.' });
  }
};

/**
 * Refuses unless every id is a person in the workspace whose account has not been deleted: one
 * query for the whole set. One missing is the same answer as one alone (D-127).
 */
export const requireWorkspacePeople = async (
  executor: Executor,
  context: Pick<WorkspaceContext, 'workspaceId'>,
  userIds: readonly string[],
): Promise<void> => {
  const wanted = [...new Set(userIds)];
  const found = await executor
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .select('users.id')
    .where('workspace_members.workspace_id', '=', context.workspaceId)
    .where('workspace_members.user_id', 'in', wanted)
    .where('users.deleted_at', 'is', null)
    .execute();
  if (found.length !== wanted.length) {
    throw new AppError({ code: 'USER_NOT_FOUND', message: 'No such person in this workspace.' });
  }
};

export interface Added {
  /** The channel as the person brought in sees it, to tell them; null when they were in it. */
  readonly forMember: Channel | null;
}

/**
 * Brings a person from the workspace into the channel the caller is in.
 *
 * The caller must be *in* the channel: seeing a public channel is not being in it, and a
 * private one is not seen by anyone outside it (`404`, from the guard). Somebody already in it
 * is the same answer, and is not told again.
 */
export const addMember = async (
  executor: Executor,
  clock: Clock,
  context: ChannelContext,
  userId: string,
): Promise<Added> => {
  if (context.channelType === 'direct_message') {
    throw new AppError({
      code: 'FORBIDDEN',
      message: 'A direct message is between the two people it was opened for.',
    });
  }
  const caller = await executor
    .selectFrom('channel_members')
    .select('user_id')
    .where('channel_id', '=', context.channelId)
    .where('user_id', '=', context.userId)
    .executeTakeFirst();
  if (caller === undefined) {
    throw new AppError({ code: 'FORBIDDEN', message: 'Join the channel to bring people into it.' });
  }
  await requireWorkspacePerson(executor, context, userId);

  const inserted = await executor
    .insertInto('channel_members')
    .values({ channel_id: context.channelId, user_id: userId, joined_at: clock.now() })
    .onConflict((conflict) => conflict.columns(['channel_id', 'user_id']).doNothing())
    .returning('user_id')
    .executeTakeFirst();
  return {
    forMember:
      inserted === undefined ? null : await channelFor(executor, userId, context.channelId),
  };
};
