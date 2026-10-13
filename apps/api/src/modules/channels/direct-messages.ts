/**
 * Opening a direct message: the same people always get the same conversation (I-5, D-99 §7,
 * D-127) — two of them, or a group of up to `CONVERSATION_PEOPLE_MAX`.
 *
 * The set of people is the conversation's identity, not a lookup that happens to find one. The
 * key is their ids sorted and joined, the database refuses any other form, and a unique index on
 * `(workspace_id, dm_key)` makes a second conversation between the same people impossible — so
 * two calls racing each other cannot make two. The insert is `ON CONFLICT DO NOTHING` and the
 * loser reads the winner's row, which is visible by then because the conflict waits for the
 * winner to commit.
 *
 * A note to self is a direct message whose two ids are the same, with one member. Its people
 * never change: there is no adding to a conversation and no leaving one — more people is another
 * conversation (D-127).
 */
import type { Transaction } from '@purlay/db';
import { CONVERSATION_PEOPLE_MAX, type Channel } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import type { WorkspaceContext } from '../../platform/tenancy';
import { channelFor } from './channels';
import { requireWorkspacePeople } from './members';

export interface OpenedConversation {
  /** As the caller sees it. */
  readonly channel: Channel;
  /**
   * As each other person sees it, only when this call created it — what their sockets are told,
   * after the commit, so the conversation exists for them without a reload. Empty when it already
   * existed, and for a note to self.
   */
  readonly forOthers: readonly { readonly userId: string; readonly channel: Channel }[];
  /** True when this call made it, a note to self included. */
  readonly created: boolean;
}

/** The people, sorted byte for byte: what `dm_key` holds and the database checks (I-5). */
const conversationKey = (people: readonly string[]): string =>
  [...people].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(':');

/** The pair, sorted: a conversation of two, or one id twice for a note to self. */
export const directMessageKey = (a: string, b: string): string => conversationKey([a, b]);

/**
 * Opens the conversation of the caller and `others`, making it the first time. `others` is
 * everybody but the caller — or the caller alone, for a note to self.
 */
export const openConversation = async (
  executor: Transaction,
  clock: Clock,
  context: WorkspaceContext,
  others: readonly string[],
): Promise<OpenedConversation> => {
  const self = others.length === 1 && others[0] === context.userId;
  if (!self && others.includes(context.userId)) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'The people to talk to are the others, not yourself.',
      details: { fields: { userIds: 'names the caller' } },
    });
  }
  const people = self ? [context.userId] : [context.userId, ...new Set(others)];
  if (people.length > CONVERSATION_PEOPLE_MAX) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'That is more people than a conversation holds; a channel holds them.',
      details: { fields: { userIds: `at most ${String(CONVERSATION_PEOPLE_MAX - 1)} people` } },
    });
  }
  await requireWorkspacePeople(executor, context, others);

  const dmKey = self ? `${context.userId}:${context.userId}` : conversationKey(people);
  const inserted = await executor
    .insertInto('channels')
    .values({
      workspace_id: context.workspaceId,
      type: 'direct_message',
      dm_key: dmKey,
      created_by: context.userId,
    })
    .onConflict((conflict) =>
      conflict.columns(['workspace_id', 'dm_key']).where('type', '=', 'direct_message').doNothing(),
    )
    .returning('id')
    .executeTakeFirst();

  const channelId =
    inserted?.id ??
    (
      await executor
        .selectFrom('channels')
        .select('id')
        .where('workspace_id', '=', context.workspaceId)
        .where('dm_key', '=', dmKey)
        .where('type', '=', 'direct_message')
        .executeTakeFirstOrThrow()
    ).id;

  // Everybody is a member whether the conversation is new or not: a membership that is already
  // there is left alone, and one that is somehow missing is restored, so a direct message can
  // never exist that one of its people cannot open.
  await executor
    .insertInto('channel_members')
    .values(
      people.map((userId) => ({ channel_id: channelId, user_id: userId, joined_at: clock.now() })),
    )
    .onConflict((conflict) => conflict.columns(['channel_id', 'user_id']).doNothing())
    .execute();

  const channel = await channelFor(executor, context.userId, channelId);
  // Read once each, in turn, and only when it is new: at most nine, the same transaction.
  const forOthers: { userId: string; channel: Channel }[] = [];
  if (inserted !== undefined && !self) {
    for (const userId of people.filter((person) => person !== context.userId)) {
      forOthers.push({ userId, channel: await channelFor(executor, userId, channelId) });
    }
  }
  return { channel, forOthers, created: inserted !== undefined };
};

export interface OpenedDirectMessage {
  /** As the caller sees it. */
  readonly channel: Channel;
  /** As the other person sees it, only when this call created it; null for a note to self. */
  readonly forPeer: Channel | null;
  readonly created: boolean;
}

/** The conversation of two — `POST …/dms`, as it was before groups. */
export const openDirectMessage = async (
  executor: Transaction,
  clock: Clock,
  context: WorkspaceContext,
  peerId: string,
): Promise<OpenedDirectMessage> => {
  const opened = await openConversation(executor, clock, context, [peerId]);
  return {
    channel: opened.channel,
    forPeer: opened.forOthers[0]?.channel ?? null,
    created: opened.created,
  };
};
