/**
 * Reacting to a message, and taking it back (D-99 §6).
 *
 * Two operations over one fact — a row of `(message, person, emoji)` — so they are
 * one function with a direction rather than two that could disagree about the
 * rules. Both answer the message's **whole** set of reactions, which is also what
 * the room is told: a client replaces what it holds rather than patching it, and a
 * missed frame is repaired by the next one.
 *
 * **Idempotent in both directions.** Reacting again, or taking back what was never
 * given, answers the set and changes nothing — and so publishes nothing: a frame
 * for a change that did not happen would make every other client re-render for no
 * reason, and let one person's double click be heard by the whole channel.
 */
import { sql, type Executor } from '@purlay/db';
import type { ReactionsResponse } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { requireMessageById } from '../../platform/channels';
import { AppError } from '../../platform/errors';
import {
  NO_LOG,
  publishAfterCommit,
  publishReactionsUpdated,
  type EventBus,
} from '../../platform/events';
import type { Logger } from '../../platform/logging';
import type { Atomically } from '../../platform/transactions';
import { requireLiveSession } from '../auth/sessions';
import { reactionSets } from '../messages/sets';

/**
 * How many different emoji one message may carry. A frame holds a message's whole
 * set, and the set is bounded by what people may add: without a cap, one person
 * could grow every other client's frame, and the rows behind it, one emoji at a
 * time. Adding your voice to an emoji already there is never refused — the cap is
 * on kinds, not on people.
 */
export const REACTION_KINDS_MAX = 20;

export interface ReactionDependencies {
  readonly atomically: Atomically;
  readonly clock: Clock;
  readonly bus: EventBus;
  /** Where a failed publish is written; the write it follows is already committed. */
  readonly log?: Logger;
}

/**
 * Serialises the writers of one message's reactions, and nobody else.
 *
 * The cap is a count followed by an insert, and two people adding different new
 * emoji at nineteen would each count nineteen and both insert — twenty-one. A lock
 * on the message row would close that, and would hold the row for the whole
 * transaction against every reply and resolution of a busy thread. An advisory lock
 * keyed on the message is held only by other reactions to it and is released with the
 * transaction, so it costs exactly the contention it prevents. (The version bump
 * (0015) does write the row, but as the transaction's last write, so a reply waits
 * for the instant between that statement and the commit, not for the whole of it.)
 */
const serialiseReactionsTo = async (executor: Executor, messageId: string): Promise<void> => {
  await sql`select pg_advisory_xact_lock(hashtextextended(${messageId}, 0))`.execute(executor);
};

/** Whether this would be a kind over the cap: new to the message, and no room for it. */
const wouldExceedKinds = async (
  executor: Executor,
  messageId: string,
  emoji: string,
): Promise<boolean> => {
  const kinds = await executor
    .selectFrom('reactions')
    .select('emoji')
    .where('message_id', '=', messageId)
    .groupBy('emoji')
    .execute();
  return kinds.length >= REACTION_KINDS_MAX && !kinds.some((kind) => kind.emoji === emoji);
};

/**
 * Adds the caller's reaction (`present`) or removes it, and answers the set.
 *
 * The message is reached through the same single-query guard every message
 * endpoint uses, so a message that does not exist, is deleted, or is in a channel
 * the caller cannot see is one refusal (D-34). The caller's session is held live
 * for the transaction (D-85), and the room is told only after it commits (D-35).
 */
export const setReaction = async (
  dependencies: ReactionDependencies,
  caller: { readonly userId: string; readonly sessionId: string },
  messageId: string,
  emoji: string,
  present: boolean,
): Promise<ReactionsResponse> => {
  const { atomically, clock, bus, log = NO_LOG } = dependencies;
  const outcome = await atomically(async (transaction) => {
    await requireLiveSession(transaction, clock, caller.sessionId);
    const { context } = await requireMessageById(transaction, caller.userId, messageId);
    await serialiseReactionsTo(transaction, messageId);

    let changed: boolean;
    if (present) {
      if (await wouldExceedKinds(transaction, messageId, emoji)) {
        throw new AppError({
          code: 'VALIDATION_FAILED',
          message: 'The request did not match the contract.',
          details: {
            fields: {
              emoji: `a message carries at most ${String(REACTION_KINDS_MAX)} different reactions`,
            },
          },
        });
      }
      const inserted = await transaction
        .insertInto('reactions')
        // The module's clock, not the database's: inside one transaction every row would carry
        // the same instant, and a set is ordered by when its reactions arrived.
        .values({ message_id: messageId, user_id: caller.userId, emoji, created_at: clock.now() })
        .onConflict((conflict) => conflict.columns(['message_id', 'user_id', 'emoji']).doNothing())
        .returning('id')
        .executeTakeFirst();
      changed = inserted !== undefined;
    } else {
      // The caller's own row only: somebody else's reaction is not theirs to take back.
      const removed = await transaction
        .deleteFrom('reactions')
        .where('message_id', '=', messageId)
        .where('user_id', '=', caller.userId)
        .where('emoji', '=', emoji)
        .returning('id')
        .executeTakeFirst();
      changed = removed !== undefined;
    }

    // Counted with the change, in this transaction, so the versions are in commit order and a
    // late frame cannot replace a newer set (0015). A repeat that changed nothing counts nothing.
    const version = changed
      ? (
          await transaction
            .updateTable('messages')
            .set({ state_version: sql<number>`state_version + 1` })
            .where('id', '=', messageId)
            .returning('state_version')
            .executeTakeFirstOrThrow()
        ).state_version
      : 0;
    const reactions = (await reactionSets(transaction, [messageId])).get(messageId) ?? [];
    return { channelId: context.channelId, reactions: [...reactions], changed, version };
  });

  if (outcome.changed) {
    await publishAfterCommit(log, [
      [
        {
          label: 'REACTIONS_UPDATED',
          run: async () =>
            await publishReactionsUpdated(
              bus,
              clock,
              { channelId: outcome.channelId, messageId, reactions: outcome.reactions },
              outcome.version,
            ),
        },
      ],
    ]);
  }
  return { reactions: outcome.reactions };
};
