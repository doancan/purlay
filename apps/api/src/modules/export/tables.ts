/**
 * What a workspace export holds, table by table and column by column (D-27 §3, D-140). Typed over the
 * generated schema (`Database`, D-45): a table or a column a migration adds is a compile error here
 * until somebody decides whether it leaves the server — a secret added later cannot ride out unseen.
 *
 * - **The workspace's own record goes**: its channels, messages and what hangs off them, its incidents,
 *   its trail, its invitations and feeds — each bounded to the workspace, and to the channels the
 *   export covers (every channel for the operator; those the asking owner can see, D-34).
 * - **Each person's own state stays**: saved items, notifications, read positions, stars, notification
 *   levels, Deep Work — a person's, not the workspace's (as D-139 §5 treats them).
 * - **Credentials and secrets never go**: sessions, sign-in links, devices, the sealed GitHub token, a
 *   feed's webhook secret, an invitation's token digest, a storage key.
 * - **People**: everyone the exported rows name, by the public projection (`User`); the address and
 *   the profile only for current members — a former member's were set after they left (D-140).
 * - Operational tables — caches, job records, the migrator's — are nobody's record.
 */
import type { Database } from '@purlay/db';

/** A column: in the export, left out, or — for people — only for current members. */
/**
 * A column: in the export, left out, only for current members, or — the address — only for current
 * members and only in the operator's export (D-140 §3).
 */
type Column = 'export' | 'omit' | 'members' | 'operator';

/** The tables an export writes, one NDJSON file each. */
export type ExportedTable =
  | 'workspaces'
  | 'workspace_members'
  | 'channels'
  | 'channel_members'
  | 'messages'
  | 'reactions'
  | 'mentions'
  | 'message_versions'
  | 'pinned_messages'
  | 'channel_bookmarks'
  | 'attachments'
  | 'incidents'
  | 'incident_updates'
  | 'incident_responders'
  | 'audit_log'
  | 'github_repo_feeds'
  | 'workspace_invitations'
  | 'users';

type Columns = { readonly [T in ExportedTable]: { readonly [C in keyof Database[T]]: Column } };

export const COLUMNS: Columns = {
  workspaces: {
    id: 'export',
    name: 'export',
    slug: 'export',
    avatar_url: 'export',
    created_at: 'export',
    created_by: 'export',
    updated_at: 'export',
    deleted_at: 'export',
    retention_days: 'export',
    storage_quota_bytes: 'export',
    storage_used_bytes: 'export',
  },
  workspace_members: {
    id: 'export',
    workspace_id: 'export',
    user_id: 'export',
    role: 'export',
    joined_at: 'export',
    // A person's own state.
    deep_work_until: 'omit',
    is_deep_work_active: 'omit',
  },
  channels: {
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
    // The realtime layer's ordering, not the record.
    state_version: 'omit',
  },
  channel_members: {
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
  messages: {
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
  reactions: {
    id: 'export',
    message_id: 'export',
    user_id: 'export',
    emoji: 'export',
    created_at: 'export',
  },
  mentions: {
    id: 'export',
    workspace_id: 'export',
    channel_id: 'export',
    message_id: 'export',
    mentioned_user_id: 'export',
    created_at: 'export',
  },
  message_versions: {
    id: 'export',
    workspace_id: 'export',
    channel_id: 'export',
    message_id: 'export',
    content: 'export',
    replaced_at: 'export',
  },
  pinned_messages: {
    workspace_id: 'export',
    channel_id: 'export',
    message_id: 'export',
    pinned_by: 'export',
    pinned_at: 'export',
  },
  // A channel's links, the members' own content about it (D-218).
  channel_bookmarks: {
    id: 'export',
    workspace_id: 'export',
    channel_id: 'export',
    url: 'export',
    title: 'export',
    added_by: 'export',
    added_at: 'export',
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
  incidents: {
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
  incident_updates: {
    id: 'export',
    incident_id: 'export',
    actor_id: 'export',
    kind: 'export',
    from_value: 'export',
    to_value: 'export',
    at: 'export',
  },
  incident_responders: {
    incident_id: 'export',
    channel_id: 'export',
    user_id: 'export',
    added_by: 'export',
    added_at: 'export',
  },
  audit_log: {
    id: 'export',
    workspace_id: 'export',
    actor_user_id: 'export',
    action: 'export',
    target_type: 'export',
    target_id: 'export',
    metadata: 'export',
    created_at: 'export',
    // A session is a credential's row, not exported: the id would name nothing.
    session_id: 'omit',
  },
  github_repo_feeds: {
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
  workspace_invitations: {
    id: 'export',
    workspace_id: 'export',
    created_by: 'export',
    created_at: 'export',
    expires_at: 'export',
    revoked_at: 'export',
    // The link's secret, digested: it would still open nothing, and says nothing either.
    token_hash: 'omit',
  },
  users: {
    id: 'export',
    username: 'export',
    display_name: 'export',
    avatar_url: 'export',
    created_at: 'export',
    deleted_at: 'export',
    // The controller's data about their own people — not about those who left (D-140).
    email: 'operator',
    title: 'members',
    time_zone: 'members',
    status_text: 'members',
    // Identity with another service, and a person's own settings and traces.
    github_id: 'omit',
    github_login: 'omit',
    github_connected_at: 'omit',
    // What the sign-in library keeps about the account, and who may run the server: the person's own,
    // and a credential's neighbour, never the controller's data about them (D-179).
    email_verified: 'omit',
    is_server_admin: 'omit',
    // The server's administrator's decision about the account (D-233): the server's, not the workspace's.
    suspended_at: 'omit',
    // Whether a password sign-in asks for a second step (D-236): a credential's neighbour, the person's own.
    two_factor_enabled: 'omit',
    // A person's own setting about when they are interrupted (D-234), as Deep Work is.
    quiet_from: 'omit',
    quiet_to: 'omit',
    quiet_days: 'omit',
    // Whether the person asked for email about what they missed (D-240): their own setting, as quiet hours.
    missed_mail_since: 'omit',
    locale: 'omit',
    last_seen_at: 'omit',
    updated_at: 'omit',
  },
};

/** Every other table, and why it is not in an export. Exhaustive: a new table must say. */
export const EXCLUDED: Readonly<Record<Exclude<keyof Database, ExportedTable>, string>> = {
  accounts: 'a provider’s account and a credential’s password hash: the person’s own (D-179)',
  verifications: 'short-lived sign-in tokens, credentials of the person’s own (D-179)',
  two_factors:
    'an authenticator app’s sealed key and the backup codes: a second credential, the person’s own (D-236)',
  rate_limits:
    'sign-in and invitation-mail counters by client address, address digest or id, nobody’s record (D-179)',
  sessions: 'a credential, the person’s own',
  push_subscriptions: 'a device’s keys, the person’s own',
  github_integrations: 'the sealed GitHub token: a credential never leaves',
  github_deliveries: 'an idempotency log of webhook deliveries, nobody’s record',
  notifications: 'each person’s inbox, their own state',
  missed_mail_letters:
    'when each person was last emailed about what they missed, and the digest of the link that stops it: a credential, the person’s own (D-240)',
  saved_messages: 'each person’s saved items, their own state',
  saved_searches: 'each person’s named filters, their own state',
  thread_follows: 'which threads each person follows or let go, their own state',
  link_previews: 'a cache of other sites’ pages',
  job_runs: 'the scheduler’s own record',
  workspace_exports: 'an export’s own record: its archive is the export',
  object_deletions:
    'storage keys waiting to be deleted: the store’s housekeeping, and keys never leave',
  server_settings:
    'the operator’s settings for the whole server, not a workspace’s; the GitHub secret and the relay’s address are credentials, which never leave (D-179)',
  server_audit_log:
    'who changed which of the server’s own settings, and when: the operator’s trail, not a workspace’s, and never exported (D-179 §4.8)',
  admin_email_verification:
    'the digest of the one link that verifies the setup administrator’s address: a credential, the server’s, never exported (D-179 §4.3)',
  invitation_passports:
    'digests of a cookie or of an address, each made from a live invitation link and spent by one sign-up: credentials, never exported (D-179 §5)',
  native_authorizations:
    'digests of one-time codes that hand a person’s session to the native application, and the challenge each is bound to: credentials, the person’s own, never exported (D-191)',
  setup_state:
    'where the server’s setup stands: digests of its one-time code and its claim, the throttle and the step reached — the server’s, not a workspace’s, and never exported (D-179 §4)',
};

/** The migrator's own tables: not in the generated schema at all, and not anybody's record. */
export const MIGRATOR_TABLES: readonly string[] = ['kysely_migration', 'kysely_migration_lock'];
