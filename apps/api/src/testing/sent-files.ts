/**
 * An upload a test sends without sending a message: the file's own claim and chat's link to the message, as
 * `linkAttachments` writes them (D-250).
 */
import { sql, type Executor } from '@purlay/db';

export const linkFile = async (
  db: Executor,
  file: { id: string; workspaceId: string; messageId: string; channelId: string },
): Promise<void> => {
  await db
    .updateTable('attachments')
    .set({ claimed_at: sql<Date>`now()` })
    .where('id', '=', file.id)
    .execute();
  await db
    .insertInto('message_attachments')
    .values({
      attachment_id: file.id,
      workspace_id: file.workspaceId,
      message_id: file.messageId,
      channel_id: file.channelId,
    })
    .execute();
};
