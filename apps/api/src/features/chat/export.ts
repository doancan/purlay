/**
 * What chat puts in a workspace's export (D-27 §3, D-140, D-250): its channels, messages and what hangs off them,
 * its incidents and feeds, each bounded to the workspace and to the channels the export covers — every channel
 * for the operator, those the asking owner can see for an owner (D-34).
 *
 * - **Each person's own state stays**: saved items, notifications, read positions, stars, notification levels,
 *   Deep Work — a person's, not the workspace's (as D-139 §5 treats them).
 * - **Credentials and secrets never go**: the sealed GitHub token, a feed's webhook secret, a storage key.
 *
 * `attachments` is the core's table, bounded here by the messages of the channels covered, because that is the
 * link it still has; it moves with the link when that becomes chat's (`MODULES.md` §10, step 8).
 */
import { sql, type Executor, type RawBuilder } from '@purlay/db';
import { visibleChannelIds } from './channels/guard';
import { tableExport, type ExportContribution, type Scope } from '../../modules/export/catalogue';

/** The channels the export covers, as `prepare` decided. */
const coveredChannels = (scope: Scope): readonly string[] => {
  const covered = scope.prepared['chat'];
  if (!Array.isArray(covered) || !covered.every((id) => typeof id === 'string')) {
    throw new Error('the export was not prepared with the channels it covers');
  }
  return covered;
};

/** The channels an operator's export covers: every channel of the workspace, archived ones too. */
export const everyChannel = async (executor: Executor, workspaceId: string): Promise<string[]> =>
  (
    await executor
      .selectFrom('channels')
      .select('id')
      .where('workspace_id', '=', workspaceId)
      .execute()
  ).map((row) => row.id);

/**
 * The scope's channels, as the database knows them: those of the workspace among the ids given. Every
 * bound goes through this, so an id of another workspace's channel, passed by mistake, selects nothing.
 */
const channelsIn = (scope: Scope): RawBuilder<unknown> =>
  sql`select id from channels where workspace_id = ${scope.workspaceId} and id = any(${coveredChannels(scope)}::uuid[])`;

/** The messages of the scope, which reactions are bounded by. */
const messagesOf = (scope: Scope): RawBuilder<unknown> =>
  sql`select id from messages where workspace_id = ${scope.workspaceId} and channel_id in (${channelsIn(scope)})`;

/** The files those messages carry, found through the link: the attachments' own `message_id` is no longer read (D-250). */
const filesOf = (scope: Scope): RawBuilder<unknown> =>
  sql`select attachment_id from message_attachments where workspace_id = ${scope.workspaceId} and message_id in (${messagesOf(scope)})`;

const incidentsOf = (scope: Scope): RawBuilder<unknown> =>
  sql`select id from incidents where workspace_id = ${scope.workspaceId} and channel_id in (${channelsIn(scope)})`;

const tables = [
  tableExport(
    'channels',
    {
      id: 'export',
      workspace_id: 'export',
      name: 'export',
      topic: 'export',
      type: 'export',
      dm_key: 'export',
      created_by: 'export',
      created_at: 'export',
      updated_at: 'export',
      deleted_at: 'export',
      last_message_at: 'export',
      // How long the channel keeps its history, as the workspace's window goes (D-225).
      min_retention_days: 'export',
      retain_forever: 'export',
      // Who posts a root in it: everybody, or its workspace's owners and admins (D-243).
      only_admins_post: 'export',
      // The realtime layer's ordering, not the record.
      state_version: 'omit',
    },
    (s) => ({ where: sql`id in (${channelsIn(s)})`, order: 'id' }),
  ),
  tableExport(
    'channel_members',
    {
      id: 'export',
      channel_id: 'export',
      user_id: 'export',
      joined_at: 'export',
      // Each person's own reading of the channel.
      last_read_message_id: 'omit',
      notification_level: 'omit',
      starred_at: 'omit',
      unread_count: 'omit',
      unread_mention_count: 'omit',
      state_version: 'omit',
    },
    (s) => ({ where: sql`channel_id in (${channelsIn(s)})`, order: 'id' }),
  ),
  tableExport(
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
      created_at: 'export',
      updated_at: 'export',
      edited_at: 'export',
      deleted_at: 'export',
      thread_reply_count: 'export',
      thread_last_reply_at: 'export',
      resolved_at: 'export',
      resolved_by: 'export',
      state_version: 'omit',
      // Bookkeeping for a client catching up (D-194), as the row's version is: not the workspace's data.
      changed_at: 'omit',
      is_question: 'export',
      question_assignee_id: 'export',
      accepted_answer_id: 'export',
      decision_note: 'export',
      decision_url: 'export',
      decision_updated_by: 'export',
      knowledge_version: 'omit',
    },
    (s) => ({ where: sql`id in (${messagesOf(s)})`, order: 'id' }),
  ),
  tableExport(
    'reactions',
    {
      id: 'export',
      message_id: 'export',
      user_id: 'export',
      emoji: 'export',
      created_at: 'export',
    },
    (s) => ({ where: sql`message_id in (${messagesOf(s)})`, order: 'id' }),
  ),
  tableExport(
    'mentions',
    {
      id: 'export',
      workspace_id: 'export',
      channel_id: 'export',
      message_id: 'export',
      mentioned_user_id: 'export',
      created_at: 'export',
    },
    (s) => ({ where: sql`message_id in (${messagesOf(s)})`, order: 'id' }),
  ),
  tableExport(
    'message_versions',
    {
      id: 'export',
      workspace_id: 'export',
      channel_id: 'export',
      message_id: 'export',
      content: 'export',
      replaced_at: 'export',
    },
    (s) => ({ where: sql`message_id in (${messagesOf(s)})`, order: 'id' }),
  ),
  tableExport(
    'pinned_messages',
    {
      workspace_id: 'export',
      channel_id: 'export',
      message_id: 'export',
      pinned_by: 'export',
      pinned_at: 'export',
    },
    (s) => ({ where: sql`message_id in (${messagesOf(s)})`, order: 'message_id' }),
  ),
  // A channel's links, the members' own content about it (D-218).
  tableExport(
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
    (s) => ({ where: sql`channel_id in (${channelsIn(s)})`, order: 'id' }),
  ),
  tableExport(
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
    (s) => ({ where: sql`id in (${filesOf(s)})`, order: 'id' }),
  ),
  tableExport(
    'incidents',
    {
      id: 'export',
      workspace_id: 'export',
      channel_id: 'export',
      severity: 'export',
      status: 'export',
      declared_by: 'export',
      declared_at: 'export',
      resolved_at: 'export',
      runbook_url: 'export',
      postmortem: 'export',
      postmortem_version: 'export',
    },
    (s) => ({ where: sql`id in (${incidentsOf(s)})`, order: 'id' }),
  ),
  tableExport(
    'incident_updates',
    {
      id: 'export',
      incident_id: 'export',
      actor_id: 'export',
      kind: 'export',
      from_value: 'export',
      to_value: 'export',
      at: 'export',
    },
    (s) => ({ where: sql`incident_id in (${incidentsOf(s)})`, order: 'id' }),
  ),
  tableExport(
    'incident_responders',
    {
      incident_id: 'export',
      channel_id: 'export',
      user_id: 'export',
      added_by: 'export',
      added_at: 'export',
    },
    (s) => ({ where: sql`incident_id in (${incidentsOf(s)})`, order: 'incident_id, user_id' }),
  ),
  tableExport(
    'github_repo_feeds',
    {
      id: 'export',
      workspace_id: 'export',
      channel_id: 'export',
      repository_id: 'export',
      repository_full_name: 'export',
      events: 'export',
      created_by: 'export',
      created_at: 'export',
      last_delivery_at: 'export',
      last_failure_at: 'export',
      last_failure: 'export',
      // The webhook's secret, sealed: a credential never leaves (D-134 §4).
      secret_encrypted: 'omit',
    },
    (s) => ({ where: sql`channel_id in (${channelsIn(s)})`, order: 'id' }),
  ),
  // The GitHub work a thread points at, as GitHub last said it (D-246): the channel's own record.
  tableExport(
    'github_links',
    {
      id: 'export',
      workspace_id: 'export',
      channel_id: 'export',
      root_id: 'export',
      repository_id: 'export',
      repository_full_name: 'export',
      kind: 'export',
      number: 'export',
      title: 'export',
      state: 'export',
      state_at: 'export',
      origin: 'export',
      created_by: 'export',
      created_at: 'export',
    },
    (s) => ({ where: sql`channel_id in (${channelsIn(s)})`, order: 'id' }),
  ),
] as const;

/** The tables chat writes into an export. */
export type ChatWritten = (typeof tables)[number]['name'];

export const chatExport: ExportContribution = {
  id: 'chat',
  prepare: async (executor, request) =>
    request.kind === 'all'
      ? await everyChannel(executor, request.workspaceId)
      : await visibleChannelIds(executor, request.viewer),
  tables,
  people: (scope) => [
    sql`select created_by from channels where id in (${channelsIn(scope)})`,
    sql`select user_id from channel_members where channel_id in (${channelsIn(scope)})`,
    sql`select sender_id from messages where id in (${messagesOf(scope)})`,
    sql`select resolved_by from messages where id in (${messagesOf(scope)})`,
    sql`select question_assignee_id from messages where id in (${messagesOf(scope)})`,
    sql`select decision_updated_by from messages where id in (${messagesOf(scope)})`,
    sql`select user_id from reactions where message_id in (${messagesOf(scope)})`,
    sql`select mentioned_user_id from mentions where message_id in (${messagesOf(scope)})`,
    sql`select pinned_by from pinned_messages where message_id in (${messagesOf(scope)})`,
    sql`select added_by from channel_bookmarks where channel_id in (${channelsIn(scope)})`,
    sql`select uploader_id from attachments where id in (${filesOf(scope)})`,
    sql`select declared_by from incidents where id in (${incidentsOf(scope)})`,
    sql`select actor_id from incident_updates where incident_id in (${incidentsOf(scope)})`,
    sql`select user_id from incident_responders where incident_id in (${incidentsOf(scope)})`,
    sql`select added_by from incident_responders where incident_id in (${incidentsOf(scope)})`,
    sql`select created_by from github_repo_feeds where channel_id in (${channelsIn(scope)})`,
    sql`select created_by from github_links where channel_id in (${channelsIn(scope)})`,
  ],
  // An upload not yet sent is the uploader's until then, and gone in a day (D-109 §5).
  files: (scope) => sql`id in (${filesOf(scope)})`,
  audit: (rows) => ({ messages: String(rows['messages'] ?? 0) }),
};

/** The tables of chat that are not in an export, and why. */
export type ChatExcluded =
  | 'message_attachments'
  | 'github_integrations'
  | 'github_deliveries'
  | 'incoming_webhooks'
  | 'github_app_installations'
  | 'github_user_authorizations'
  | 'github_app_handshakes'
  | 'github_app_deliveries'
  | 'github_operations'
  | 'notifications'
  | 'missed_mail_letters'
  | 'saved_messages'
  | 'saved_searches'
  | 'thread_follows'
  | 'link_previews';

export const CHAT_EXCLUDED: Readonly<Record<ChatExcluded, string>> = {
  message_attachments:
    'which message a file was sent with: written beside the file’s own `message_id` and `channel_id`, which the export carries, until those move here and this table is what carries them',
  github_integrations: 'the sealed GitHub token: a credential never leaves',
  github_deliveries: 'an idempotency log of webhook deliveries, nobody’s record',
  incoming_webhooks:
    'a channel’s incoming webhooks: each the digest of the secret its address carries, a credential, never exported; what they posted is in `messages`, under the name each posted with (D-245)',
  github_app_installations:
    'which installation of the server’s GitHub App the workspace connected: a connection to a credential the server holds, as the token is (D-246)',
  github_user_authorizations:
    'a person’s sealed GitHub App tokens: credentials, the person’s own, never exported (D-246)',
  github_app_handshakes:
    'digests of the state of a trip to GitHub and back, and its sealed verifier, for ten minutes: credentials (D-246)',
  github_app_deliveries:
    'an idempotency log of the GitHub App’s deliveries, nobody’s record (D-246)',
  github_operations:
    'the bounded record of one attempt to make an issue — its request id, a digest of what was asked, never the words: an idempotency record, nobody’s (D-246 §4)',
  notifications: 'each person’s inbox, their own state',
  missed_mail_letters:
    'when each person was last emailed about what they missed, and the digest of the link that stops it: a credential, the person’s own (D-240)',
  saved_messages: 'each person’s saved items, their own state',
  saved_searches: 'each person’s named filters, their own state',
  thread_follows: 'which threads each person follows or let go, their own state',
  link_previews: 'a cache of other sites’ pages',
};
