/**
 * Away by choice (D-257): the person's own, kept on their row until they choose again. It wins over activity
 * — a person who chose away and keeps using Purlay stays away — and loses to offline: nobody offline is told
 * away. What is told is the announcer's to work out (`features/chat/presence/presence.ts`), from this column
 * and the node's idleness together; this only keeps the choice.
 */
import type { Executor } from '@purlay/db';

export const setAwayChoice = async (
  executor: Executor,
  userId: string,
  away: boolean,
): Promise<void> => {
  await executor.updateTable('users').set({ away_chosen: away }).where('id', '=', userId).execute();
};
