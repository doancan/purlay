/**
 * What a person's export holds, and the tables the migrator keeps. A workspace's export is described by the
 * contributions in `core-export.ts` and each module's own (`catalogue.ts`, D-250); a person's still is here, typed
 * over the generated schema (`Database`, D-45) the same way.
 */
import type { Database } from '@purlay/db';

/** The migrator's own tables: not in the generated schema at all, and not anybody's record. */
export const MIGRATOR_TABLES: readonly string[] = ['kysely_migration', 'kysely_migration_lock'];

/**
 * What a person's export of their own data holds (D-241), decided the same way: a table or a column a
 * migration adds is a compile error here until somebody decides whether a person's own copy carries it.
 *
 * - **Everything about them goes**: their account's fields (none of which is a secret — the password's
 *   hash, the second step's key and the sessions' tokens live in other tables), their memberships and
 *   what they set on each — notification levels, stars, Deep Work, threads followed — what they wrote,
 *   reacted, saved, searched for and kept as a channel's link, and the files they sent.
 * - **Nothing of anybody else's**: no other person's row, words or name. A row of theirs names other
 *   things by id — a message they reacted to, a channel — and only the workspaces and channels their
 *   rows name are written, by id, name and kind, so the ids mean something.
 * - **What is the thread's or the team's, not theirs, stays**: who resolved it, who it was assigned to,
 *   the decision someone noted, its replies' count — and the realtime layer's bookkeeping.
 */
type Personal = 'export' | 'omit';

/** The tables a person's export writes, one NDJSON file each. */
export type PersonalTable =
  | 'users'
  | 'workspaces'
  | 'workspace_members'
  | 'channels'
  | 'channel_members'
  | 'messages'
  | 'reactions'
  | 'attachments'
  | 'saved_messages'
  | 'saved_searches'
  | 'thread_follows'
  | 'channel_bookmarks';

type PersonalColumns = {
  readonly [T in PersonalTable]: { readonly [C in keyof Database[T]]: Personal };
};

export const PERSONAL_COLUMNS: PersonalColumns = {
  // Their own row, every field: what the server holds about who they are and how they sign in.
  users: {
    id: 'export',
    username: 'export',
    display_name: 'export',
    avatar_url: 'export',
    email: 'export',
    email_verified: 'export',
    github_id: 'export',
    github_login: 'export',
    github_connected_at: 'export',
    title: 'export',
    time_zone: 'export',
    status_text: 'export',
    locale: 'export',
    quiet_from: 'export',
    quiet_to: 'export',
    quiet_days: 'export',
    // Since when they asked to be mailed about what they missed (D-240): a setting of theirs.
    missed_mail_since: 'export',
    two_factor_enabled: 'export',
    is_server_admin: 'export',
    suspended_at: 'export',
    last_seen_at: 'export',
    created_at: 'export',
    updated_at: 'export',
    deleted_at: 'export',
  },
  // A workspace their rows name: enough to say which it was.
  workspaces: {
    id: 'export',
    name: 'export',
    slug: 'export',
    created_at: 'omit',
    created_by: 'omit',
    avatar_url: 'omit',
    updated_at: 'omit',
    deleted_at: 'omit',
    retention_days: 'omit',
    storage_quota_bytes: 'omit',
    storage_used_bytes: 'omit',
    purge_started_at: 'omit',
    purged_at: 'omit',
  },
  workspace_members: {
    id: 'export',
    workspace_id: 'export',
    user_id: 'export',
    role: 'export',
    joined_at: 'export',
    deep_work_until: 'export',
    is_deep_work_active: 'export',
  },
  // A channel their rows name: which, in which workspace, and what kind. A direct conversation's key is
  // the other person's id.
  channels: {
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
  channel_members: {
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
  // What they wrote and has not been deleted: a deleted message's words are not offered back (D-9).
  messages: {
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
  reactions: {
    id: 'export',
    message_id: 'export',
    user_id: 'export',
    emoji: 'export',
    created_at: 'export',
  },
  attachments: {
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
    // Where the object is kept on this server: the export names it by its id instead.
    storage_key: 'omit',
    thumbnail_key: 'omit',
  },
  saved_messages: {
    id: 'export',
    workspace_id: 'export',
    channel_id: 'export',
    message_id: 'export',
    user_id: 'export',
    state: 'export',
    saved_at: 'export',
    updated_at: 'export',
  },
  saved_searches: {
    id: 'export',
    workspace_id: 'export',
    user_id: 'export',
    name: 'export',
    query: 'export',
    created_at: 'export',
  },
  thread_follows: {
    workspace_id: 'export',
    channel_id: 'export',
    message_id: 'export',
    user_id: 'export',
    following: 'export',
    updated_at: 'export',
  },
  channel_bookmarks: {
    id: 'export',
    workspace_id: 'export',
    channel_id: 'export',
    url: 'export',
    title: 'export',
    added_by: 'export',
    added_at: 'export',
  },
};

/** Every other table, and why a person's export leaves it out. Exhaustive: a new table must say. */
export const PERSONAL_EXCLUDED: Readonly<Record<Exclude<keyof Database, PersonalTable>, string>> = {
  accounts: 'a provider’s account and a password’s hash: a credential (GitHub’s id is on `users`)',
  verifications: 'short-lived sign-in tokens: credentials',
  two_factors: 'an authenticator’s sealed key and the backup codes: a credential (D-236)',
  sessions: 'a credential; where they are signed in is listed in Sessions & account (D-193)',
  push_subscriptions: 'a device’s keys: a credential of the browser’s',
  native_authorizations: 'digests of one-time codes: credentials (D-191)',
  invitation_passports: 'digests of a cookie or an address: credentials (D-179 §5)',
  admin_email_verification: 'the digest of a link that verifies an address: a credential',
  rate_limits: 'counters by client address or digest, nobody’s record',
  notifications:
    'pointers to other people’s messages that mentioned or answered them: the words are the others’',
  mentions: 'who another person’s message named: the message is the other person’s',
  message_versions:
    'the words an edit replaced: not offered back, as a deleted message’s words are not (D-9)',
  pinned_messages: 'a channel’s pins: the channel’s record, not theirs',
  incidents: 'a channel’s incident: the team’s record',
  incident_updates: 'an incident’s timeline: the team’s record',
  incident_responders: 'who responded to an incident: the team’s record',
  audit_log: 'a workspace’s trail: its owners’ record, not the person’s',
  server_audit_log: 'the server’s trail: the operator’s record',
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
  workspace_invitations: 'a workspace’s links and their digests: the workspace’s, and credentials',
  link_previews: 'a cache of other sites’ pages',
  job_runs: 'the scheduler’s own record',
  object_deletions: 'storage keys waiting to be deleted: keys never leave',
  workspace_exports: 'an owner’s export of a workspace: the workspace’s record',
  personal_exports:
    'the record of this very export and the ones before it: its archive is the export',
  server_settings: 'the operator’s settings for the whole server',
  setup_state: 'where the server’s setup stands: the server’s',
  missed_mail_letters:
    'when each letter about what they missed went, and its stop link’s digest: a credential (D-240)',
};
