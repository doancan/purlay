/**
 * What chat puts in a person's export of their own data (D-241, D-250): their channels' memberships and what they
 * set on each, what they wrote, reacted, saved, searched for and kept as a channel's link, and the files they sent.
 *
 * - **Bounded to the person**, by each table's own column naming them or by the messages they wrote. What they
 *   wrote in a channel or a workspace they have since left is theirs and goes.
 * - **Their words that stand**: a deleted message is not offered back, and neither are its files (D-9).
 * - **A channel their rows name** is written by id, name and kind, so the ids mean something; a direct
 *   conversation's key is the other person's id and stays out.
 * - **What is the thread's or the team's, not theirs, stays**: who resolved it, who it was assigned to, the
 *   decision someone noted, its replies' count — and the realtime layer's bookkeeping.
 *
 * `attachments` is the core's table, bounded here by the messages the person wrote, because that is the link it
 * still has; it moves with the link when that becomes chat's (`MODULES.md` §10, step 8).
 */
import { sql, tableExists, type Executor, type RawBuilder } from '@purlay/db';
import {
  personalTableExport,
  type PersonalContribution,
} from '../../modules/export/personal-catalogue';

/** The messages the person wrote that stand: every bound of their words goes through this. */
const theirMessages = (userId: string): RawBuilder<unknown> =>
  sql`select id from messages where sender_id = ${userId} and deleted_at is null`;

/** The files they sent with those messages; one uploaded and never sent is gone within a day (D-109 §5). */
const theirFiles = async (userId: string, executor: Executor): Promise<RawBuilder<unknown>> =>
  // The link is made by chat's own migration set: where it was never applied no message carried a file.
  (await tableExists(executor, 'message_attachments'))
    ? sql`uploader_id = ${userId} and id in (
        select attachment_id from message_attachments where message_id in (${theirMessages(userId)})
      )`
    : sql`false`;

/** The channels the person's rows name, so each id in the export says which channel it was. */
const theirChannels = (userId: string): RawBuilder<unknown> => sql`
  select channel_id from channel_members where user_id = ${userId}
  union select channel_id from messages where id in (${theirMessages(userId)})
  union select channel_id from saved_messages where user_id = ${userId}
  union select channel_id from thread_follows where user_id = ${userId}
  union select channel_id from channel_bookmarks where added_by = ${userId}
`;

const tables = [
  personalTableExport(
    'channels',
    {
      id: 'export',
      workspace_id: 'export',
      name: 'export',
      type: 'export',
      topic: 'omit',
      dm_key: 'omit',
      created_by: 'omit',
      created_at: 'omit',
      updated_at: 'omit',
      deleted_at: 'omit',
      last_message_at: 'omit',
      min_retention_days: 'omit',
      retain_forever: 'omit',
      only_admins_post: 'omit',
      state_version: 'omit',
    },
    (userId) => ({ where: sql`id in (${theirChannels(userId)})`, order: 'id' }),
  ),
  personalTableExport(
    'channel_members',
    {
      id: 'export',
      channel_id: 'export',
      user_id: 'export',
      joined_at: 'export',
      last_read_message_id: 'export',
      notification_level: 'export',
      starred_at: 'export',
      // Counts the server keeps for the badge, and the realtime layer's ordering.
      unread_count: 'omit',
      unread_mention_count: 'omit',
      state_version: 'omit',
    },
    (userId) => ({ where: sql`user_id = ${userId}`, order: 'id' }),
  ),
  // What they wrote and has not been deleted: a deleted message's words are not offered back (D-9).
  personalTableExport(
    'messages',
    {
      id: 'export',
      workspace_id: 'export',
      channel_id: 'export',
      parent_id: 'export',
      sender_id: 'export',
      message_type: 'export',
      content: 'export',
      metadata: 'export',
      is_question: 'export',
      created_at: 'export',
      updated_at: 'export',
      edited_at: 'export',
      deleted_at: 'omit',
      // The thread's, and other people's acts on it.
      thread_reply_count: 'omit',
      thread_last_reply_at: 'omit',
      resolved_at: 'omit',
      resolved_by: 'omit',
      question_assignee_id: 'omit',
      accepted_answer_id: 'omit',
      decision_note: 'omit',
      decision_url: 'omit',
      decision_updated_by: 'omit',
      state_version: 'omit',
      changed_at: 'omit',
      knowledge_version: 'omit',
    },
    (userId) => ({ where: sql`id in (${theirMessages(userId)})`, order: 'id' }),
  ),
  personalTableExport(
    'reactions',
    {
      id: 'export',
      message_id: 'export',
      user_id: 'export',
      emoji: 'export',
      created_at: 'export',
    },
    (userId) => ({ where: sql`user_id = ${userId}`, order: 'id' }),
  ),
  personalTableExport(
    'attachments',
    {
      id: 'export',
      workspace_id: 'export',
      channel_id: 'export',
      message_id: 'export',
      uploader_id: 'export',
      file_name: 'export',
      mime_type: 'export',
      kind: 'export',
      size_bytes: 'export',
      width: 'export',
      height: 'export',
      created_at: 'export',
      // The core's note that a module has taken the file (0079): bookkeeping, not content.
      claimed_at: 'omit',
      // Where the object is kept on this server: the export names it by its id instead.
      storage_key: 'omit',
      thumbnail_key: 'omit',
    },
    async (userId, _workspaces, executor) => ({
      where: await theirFiles(userId, executor),
      order: 'id',
    }),
  ),
  personalTableExport(
    'saved_messages',
    {
      id: 'export',
      workspace_id: 'export',
      channel_id: 'export',
      message_id: 'export',
      user_id: 'export',
      state: 'export',
      saved_at: 'export',
      updated_at: 'export',
    },
    (userId) => ({ where: sql`user_id = ${userId}`, order: 'id' }),
  ),
  personalTableExport(
    'saved_searches',
    {
      id: 'export',
      workspace_id: 'export',
      user_id: 'export',
      name: 'export',
      query: 'export',
      created_at: 'export',
    },
    (userId) => ({ where: sql`user_id = ${userId}`, order: 'id' }),
  ),
  personalTableExport(
    'thread_follows',
    {
      workspace_id: 'export',
      channel_id: 'export',
      message_id: 'export',
      user_id: 'export',
      following: 'export',
      updated_at: 'export',
    },
    (userId) => ({ where: sql`user_id = ${userId}`, order: 'message_id' }),
  ),
  personalTableExport(
    'channel_bookmarks',
    {
      id: 'export',
      workspace_id: 'export',
      channel_id: 'export',
      url: 'export',
      title: 'export',
      added_by: 'export',
      added_at: 'export',
    },
    (userId) => ({ where: sql`added_by = ${userId}`, order: 'id' }),
  ),
] as const;

/** The tables of chat that are not in a person's export, and why. */
type ChatPersonalExcluded =
  | 'message_attachments'
  | 'hidden_messages'
  | 'message_reminders'
  | 'scheduled_messages'
  | 'scheduled_message_attachments'
  | 'notifications'
  | 'mentions'
  | 'message_versions'
  | 'pinned_messages'
  | 'incidents'
  | 'incident_updates'
  | 'incident_responders'
  | 'github_repo_feeds'
  | 'github_integrations'
  | 'github_deliveries'
  | 'incoming_webhooks'
  | 'github_app_installations'
  | 'github_user_authorizations'
  | 'github_app_handshakes'
  | 'github_app_deliveries'
  | 'github_links'
  | 'github_operations'
  | 'link_previews'
  | 'missed_mail_letters';

const CHAT_PERSONAL_EXCLUDED: Readonly<Record<ChatPersonalExcluded, string>> = {
  message_attachments:
    'which message a file was sent with: the file’s own `message_id` and `channel_id` carry it, until they move here',
  hidden_messages: 'markers of messages deleted for this person only: other people’s words, hidden',
  message_reminders: 'pending private reminders: transient, gone once they are delivered',
  scheduled_messages: 'pending unsent messages: transient, exported as messages once they are sent',
  scheduled_message_attachments:
    'which unsent message holds a file: transient, as the message is; the file goes with it once it is sent',
  notifications:
    'pointers to other people’s messages that mentioned or answered them: the words are the others’',
  mentions: 'who another person’s message named: the message is the other person’s',
  message_versions:
    'the words an edit replaced: not offered back, as a deleted message’s words are not (D-9)',
  pinned_messages: 'a channel’s pins: the channel’s record, not theirs',
  incidents: 'a channel’s incident: the team’s record',
  incident_updates: 'an incident’s timeline: the team’s record',
  incident_responders: 'who responded to an incident: the team’s record',
  github_repo_feeds: 'a channel’s feed and its sealed secret: the workspace’s',
  github_integrations: 'the workspace’s sealed GitHub token: a credential',
  github_deliveries: 'an idempotency log of webhook deliveries, nobody’s record',
  incoming_webhooks:
    'a channel’s incoming webhooks: the digest of a secret, a credential, and the workspace’s (D-245)',
  github_app_installations: 'the workspace’s connection to the server’s GitHub App (D-246)',
  github_user_authorizations:
    'the person’s sealed GitHub App tokens: credentials, never exported (D-246)',
  github_app_handshakes:
    'digests and a sealed verifier of a trip to GitHub, ten minutes long: credentials',
  github_app_deliveries: 'an idempotency log of the GitHub App’s deliveries, nobody’s record',
  github_links:
    'the GitHub work a thread points at: the team’s record, in the workspace’s export (D-246)',
  github_operations: 'a bounded idempotency record of making an issue: nobody’s record (D-246 §4)',
  link_previews: 'a cache of other sites’ pages',
  missed_mail_letters:
    'when each letter about what they missed went, and its stop link’s digest: a credential (D-240)',
};

export const chatPersonalExport = {
  id: 'chat',
  tables,
  workspaces: (userId: string): RawBuilder<unknown>[] => [
    sql`select workspace_id from channels where id in (${theirChannels(userId)})`,
    sql`select workspace_id from saved_searches where user_id = ${userId}`,
  ],
  files: theirFiles,
  excluded: CHAT_PERSONAL_EXCLUDED,
} satisfies PersonalContribution;
