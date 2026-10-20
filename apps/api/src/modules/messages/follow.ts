/**
 * Following a thread, and letting it go (D-161).
 *
 * **Without a choice, participation decides (D-29):** a person follows a thread they started or have
 * answered. **A choice, either way, is kept** in `thread_follows` until they make another — replying
 * again after letting a thread go does not quietly follow it again, because the one thing the person
 * said about this thread was *stop*, and a reply is not a request to be interrupted.
 *
 * What a choice moves is only the thread's own reason to tell somebody: `thread_reply`, and — for a
 * reply in a thread let go — the weakest one, a channel at every message (D-107). A mention is
 * addressed to the person and a direct message is written to them; neither is the thread's to
 * silence. A channel at `none` stays silent for a thread followed (D-107 §1). Deep Work, the
 * counters and `NEEDS_YOU` are as they were: this decides who has a reason, nothing after.
 */
import type { Executor } from '@purlay/db';
import type { ThreadFollow } from '@purlay/types';
import { AppError } from '../../platform/errors';
import type { Clock } from '../../platform/clock';
import type { VisibleMessage } from '../../platform/channels';

/** A reply has no thread: asking about one is asking about a message that is not there. */
const requireRoot = (root: VisibleMessage): void => {
  if (root.parentId !== null) {
    throw new AppError({ code: 'MESSAGE_NOT_FOUND', message: 'Message not found.' });
  }
};

/** Whether the caller is told of new replies in this root's thread. */
export const followState = async (
  executor: Executor,
  root: VisibleMessage,
): Promise<ThreadFollow> => {
  requireRoot(root);
  const userId = root.context.userId;
  const choice = await executor
    .selectFrom('thread_follows')
    .select('following')
    .where('user_id', '=', userId)
    .where('message_id', '=', root.messageId)
    .executeTakeFirst();
  if (choice !== undefined) return { following: choice.following };
  // The participants a reply finds (`delivery.ts`): the root's author, and who has a live reply.
  const took = await executor
    .selectFrom('messages')
    .select('id')
    .where('sender_id', '=', userId)
    .where((eb) =>
      eb.or([
        eb('id', '=', root.messageId),
        eb.and([eb('parent_id', '=', root.messageId), eb('deleted_at', 'is', null)]),
      ]),
    )
    .limit(1)
    .executeTakeFirst();
  return { following: took !== undefined };
};

/** Records the caller's choice for this root's thread, and answers it. Twice is once. */
export const setFollowing = async (
  executor: Executor,
  clock: Clock,
  root: VisibleMessage,
  following: boolean,
): Promise<ThreadFollow> => {
  requireRoot(root);
  const now = clock.now();
  await executor
    .insertInto('thread_follows')
    .values({
      user_id: root.context.userId,
      workspace_id: root.context.workspaceId,
      channel_id: root.context.channelId,
      message_id: root.messageId,
      following,
      updated_at: now,
    })
    .onConflict((conflict) =>
      conflict.columns(['user_id', 'message_id']).doUpdateSet({ following, updated_at: now }),
    )
    .execute();
  return { following };
};

/** The choices made about one thread: who follows it and who let it go, most recent first. */
export interface ThreadChoices {
  readonly followed: readonly string[];
  readonly unfollowed: ReadonlySet<string>;
}

/**
 * Every choice about this root's thread, over `idx_thread_follows_message`: one indexed lookup per
 * reply, beside D-29's. Bounded by who can see the channel, since a row is somebody's own choice.
 */
export const threadChoices = async (executor: Executor, rootId: string): Promise<ThreadChoices> => {
  const rows = await executor
    .selectFrom('thread_follows')
    .select(['user_id', 'following'])
    .where('message_id', '=', rootId)
    .orderBy('updated_at', 'desc')
    .orderBy('user_id')
    .execute();
  return {
    followed: rows.filter((row) => row.following).map((row) => row.user_id),
    unfollowed: new Set(rows.filter((row) => !row.following).map((row) => row.user_id)),
  };
};
