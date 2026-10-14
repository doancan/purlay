/**
 * A repository's event as a message (D-134 §6), for tests of what one is to everything else: the
 * row a feed's writer makes — a `system_event` with no sender, the event as its metadata and an
 * English summary as its words, counted unread for every member — written directly, so the readers
 * can be tested before, and apart from, the webhook that writes them.
 */
import { sql, type Executor } from '@purlay/db';
import { messageId, type GitHubEvent } from '@purlay/types';

export const A_PUSH: GitHubEvent = {
  kind: 'push',
  repository: 'acme/api',
  actor: 'octocat',
  ref: { type: 'branch', name: 'main' },
  change: 'pushed',
  before: 'a'.repeat(40),
  after: 'b'.repeat(40),
  commits: [{ sha: 'b'.repeat(40), title: 'Retry with jitter' }],
  commitCount: 1,
};

export const anEventMessage = async (
  db: Executor,
  where: { readonly workspaceId: string; readonly channelId: string },
  at: Date,
  event: GitHubEvent = A_PUSH,
): Promise<string> => {
  const id = messageId(at);
  await db
    .insertInto('messages')
    .values({
      id,
      workspace_id: where.workspaceId,
      channel_id: where.channelId,
      sender_id: null,
      message_type: 'system_event',
      metadata: event,
      content: `${event.actor} pushed to ${event.repository}`,
      created_at: at,
    })
    .execute();
  // Unread for every member whose position is before it, as the writer must count it: nobody wrote it.
  await db
    .updateTable('channel_members')
    .set({
      unread_count: sql<number>`unread_count + 1`,
      state_version: sql<number>`state_version + 1`,
    })
    .where('channel_id', '=', where.channelId)
    .where((eb) =>
      eb.or([eb('last_read_message_id', 'is', null), eb('last_read_message_id', '<', id)]),
    )
    .execute();
  return id;
};
