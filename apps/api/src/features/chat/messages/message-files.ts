/**
 * The files of messages, dropped with them (D-141, D-250). Which attachments a message carries is chat's to
 * know — `message_attachments` — and the core's `dropFilesById` deletes them without knowing why.
 */
import type { ChatTx } from '../schema';
import { dropFilesById } from '../../../modules/attachments/deletions';

/** The files of these messages: rows deleted, bytes off the workspace, keys queued and returned (see `dropFilesById`). */
export const dropMessageFiles = async (
  transaction: ChatTx,
  workspaceId: string,
  messageIds: readonly string[],
): Promise<{ readonly count: number; readonly keys: readonly string[] }> => {
  if (messageIds.length === 0) return { count: 0, keys: [] };
  const linked = await transaction
    .selectFrom('message_attachments')
    .select('attachment_id')
    .where('workspace_id', '=', workspaceId)
    .where('message_id', 'in', messageIds)
    .execute();
  return await dropFilesById(
    transaction,
    workspaceId,
    linked.map((row) => row.attachment_id),
  );
};
