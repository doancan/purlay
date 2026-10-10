/**
 * What a page of messages carries beyond their own rows: who reacted, and who is
 * mentioned (D-99 §8).
 *
 * **One query each, for the whole page.** A feed of fifty roots must not become a
 * hundred more queries — the rule D-13 states for counters holds for every page.
 * Both take ids and return a map, so history, a thread, the open-questions view,
 * a replay and the answer to a send build their messages through the same two
 * calls, and a page that arrives by a different route cannot differ in what it says.
 */
import { sql, type Executor } from '@purlay/db';
import type { Reaction } from '@purlay/types';

/**
 * Reactions by message, each emoji's people in the order they reacted and the
 * emoji themselves in the order the first of each arrived — so a reaction does not
 * hop sideways when somebody else adds theirs.
 */
export const reactionSets = async (
  executor: Executor,
  messageIds: readonly string[],
): Promise<ReadonlyMap<string, readonly Reaction[]>> => {
  const sets = new Map<string, Reaction[]>();
  if (messageIds.length === 0) return sets;
  const rows = await executor
    .selectFrom('reactions')
    .select([
      'message_id',
      'emoji',
      sql<string[]>`array_agg(user_id order by created_at, id)`.as('user_ids'),
    ])
    .where('message_id', 'in', messageIds)
    .groupBy(['message_id', 'emoji'])
    .orderBy(sql`min(created_at)`)
    .orderBy('emoji')
    .execute();
  for (const row of rows) {
    const list = sets.get(row.message_id) ?? [];
    list.push({ emoji: row.emoji, userIds: row.user_ids });
    sets.set(row.message_id, list);
  }
  return sets;
};

/** The people each message names, in a stable order. */
export const mentionSets = async (
  executor: Executor,
  messageIds: readonly string[],
): Promise<ReadonlyMap<string, readonly string[]>> => {
  const sets = new Map<string, string[]>();
  if (messageIds.length === 0) return sets;
  const rows = await executor
    .selectFrom('mentions')
    .select(['message_id', 'mentioned_user_id'])
    .where('message_id', 'in', messageIds)
    .orderBy('created_at')
    .orderBy('mentioned_user_id')
    .execute();
  for (const row of rows) {
    const list = sets.get(row.message_id) ?? [];
    list.push(row.mentioned_user_id);
    sets.set(row.message_id, list);
  }
  return sets;
};
