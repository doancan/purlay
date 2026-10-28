import { sql, type Executor, type RawBuilder } from '@purlay/db';
import type { Message } from '@purlay/types';

/** Personal lists omit hidden messages before pagination. Shared content remains available to others. */
export const notHiddenBy = (
  userId: string,
  message: RawBuilder<unknown> = sql.ref('messages.id'),
): RawBuilder<boolean> =>
  sql<boolean>`not exists (select 1 from hidden_messages h where h.user_id = ${userId} and h.message_id = ${message})`;

export const hiddenMessage = (message: Message, at: string): Message => ({
  ...message,
  hiddenForMe: true,
  content: '',
  deletedAt: message.deletedAt ?? at,
  editedAt: null,
  githubEvent: null,
  attachments: [],
  mentions: [],
  reactions: [],
});

/** A batch projection preserves keyset cursors and reply ancestry, while removing the hidden words. */
export const hideForReader = async (
  db: Executor,
  userId: string | undefined,
  messages: Message[],
): Promise<Message[]> => {
  if (userId === undefined || messages.length === 0) return messages;
  const rows = await db
    .selectFrom('hidden_messages')
    .select(['message_id', 'hidden_at'])
    .where('user_id', '=', userId)
    .where(
      'message_id',
      'in',
      messages.map((message) => message.id),
    )
    .execute();
  const hidden = new Map(rows.map((row) => [row.message_id, row.hidden_at.toISOString()]));
  return messages.map((message) => {
    const at = hidden.get(message.id);
    return at === undefined ? message : hiddenMessage(message, at);
  });
};
