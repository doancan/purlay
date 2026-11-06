/**
 * What chat adds to the purge of a deleted workspace (D-242, D-250): its messages and their files, replies
 * first (a root is held by its replies, `ON DELETE RESTRICT`), then roots; after the core's uploads and exports,
 * its channels, a batch at a time, each taking its memberships, feeds, incidents and bookmarks with it; and the
 * tables of chat that still name the workspace once those are gone. The core owns the order, the batches'
 * transactions and the drain of the keys (`workspaces/deletion-purge.ts`).
 */
import type { ChatTx } from '../schema';
import {
  WORKSPACE_PURGE_BATCH,
  type Batch,
  type WorkspacePurge,
} from '../../../modules/workspaces/deletion-purge';
import { dropMessageFiles } from './message-files';

/** Channels one transaction takes: each takes its memberships, feeds, incidents and bookmarks with it. */
const CHANNEL_BATCH = 100;

/** A batch of the workspace's messages: replies while any is left, then roots. */
const messageBatch =
  (replies: boolean) =>
  async (transaction: ChatTx, workspaceId: string): Promise<Batch> => {
    const ids = (
      await transaction
        .selectFrom('messages')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .where('parent_id', replies ? 'is not' : 'is', null)
        .orderBy('created_at')
        .limit(WORKSPACE_PURGE_BATCH)
        .execute()
    ).map((row) => row.id);
    if (ids.length === 0) return { rows: 0, files: 0, keys: [] };
    const files = await dropMessageFiles(transaction, workspaceId, ids);
    await transaction.deleteFrom('messages').where('id', 'in', ids).execute();
    return { rows: ids.length, files: files.count, keys: files.keys };
  };

const channelBatch = async (transaction: ChatTx, workspaceId: string): Promise<Batch> => {
  const gone = await transaction
    .deleteFrom('channels')
    .where(
      'id',
      'in',
      transaction
        .selectFrom('channels')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .limit(CHANNEL_BATCH),
    )
    .executeTakeFirst();
  return { rows: Number(gone.numDeletedRows), files: 0, keys: [] };
};

export const chatWorkspacePurge: WorkspacePurge = {
  before: [
    { batch: messageBatch(true), size: WORKSPACE_PURGE_BATCH, messages: true },
    { batch: messageBatch(false), size: WORKSPACE_PURGE_BATCH, messages: true },
  ],
  after: [{ batch: channelBatch, size: CHANNEL_BATCH, messages: false }],
  tables: [
    'scheduled_messages',
    'message_reminders',
    'hidden_messages',
    'mentions',
    'notifications',
    'saved_messages',
    'pinned_messages',
    'message_versions',
    'thread_follows',
    'channel_bookmarks',
    'github_repo_feeds',
    'incidents',
    'saved_searches',
    'github_integrations',
    'github_app_installations',
    'github_app_handshakes',
    'github_links',
    'github_operations',
    'incoming_webhooks',
  ],
};
